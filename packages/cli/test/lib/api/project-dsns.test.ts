/** Tests for listing public DSNs through the API SDK. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  listOrganizationDsns,
  listProjectDsns,
} from "../../../src/lib/api/projects.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { ApiError } from "../../../src/lib/errors.js";
import {
  disableResponseCache,
  resetCacheState,
} from "../../../src/lib/response-cache.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { mockFetch, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("project-dsns-api-test-");

const PUBLIC_DSN = "https://public-key@o1.ingest.de.sentry.io/42";
const BACKEND_DSN = "https://other-key@o1.ingest.de.sentry.io/7";

/** Include raw API fields that must never escape the user-facing projection. */
function projectKey(index = 0) {
  return {
    id: `internal-key-${index}`,
    name: `Key ${index}`,
    label: `Key ${index}`,
    isActive: true,
    dateCreated: "2026-01-01T00:00:00Z",
    projectId: 42,
    public: "public-key",
    secret: "legacy-secret",
    dsn: {
      public: PUBLIC_DSN,
      secret: "https://public-key:legacy-secret@o1.ingest.de.sentry.io/42",
      csp: "https://o1.ingest.de.sentry.io/api/42/csp-report/",
    },
    rateLimit: { count: 100, window: 60 },
    browserSdkVersion: "latest",
    dynamicSdkLoaderOptions: { hasReplay: true },
    useCase: "internal",
    unexpectedPrivateField: "must-not-be-exposed",
  };
}

function keysResponse(body: unknown, nextCursor?: string): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      ...(nextCursor
        ? {
            Link: `<https://de.sentry.io/api/0/next/>; rel="next"; results="true"; cursor="${nextCursor}"`,
          }
        : {}),
    },
  });
}

/** Serve project metadata separately so tests can inspect key and lookup requests. */
function mockKeys(respond: (url: URL) => Response) {
  const requests: Request[] = [];
  const projectIds: string[] = [];
  globalThis.fetch = mockFetch(async (input, init) => {
    const request = new Request(input!, init);
    const url = new URL(request.url);
    const id = /\/projects\/test-org\/(42|7)\/$/.exec(url.pathname)?.[1];
    if (id) {
      projectIds.push(id);
      return keysResponse({ id, slug: id === "42" ? "frontend" : "backend" });
    }
    requests.push(request);
    return respond(url);
  });
  return { requests, projectIds };
}

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  resetCacheState();
  disableResponseCache();
  resetAuthenticatedFetch();
  await setAuthToken("test-token");
  setOrgRegion("test-org", "https://de.sentry.io");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCacheState();
  resetAuthenticatedFetch();
});

type ListOptions = Parameters<typeof listOrganizationDsns>[1];

describe.each([
  {
    scope: "project",
    path: "/api/0/projects/test-org/frontend/keys/",
    list: (options?: ListOptions) =>
      listProjectDsns("test-org", "frontend", options),
  },
  {
    scope: "organization",
    path: "/api/0/organizations/test-org/project-keys/",
    list: (options?: ListOptions) => listOrganizationDsns("test-org", options),
  },
])("$scope DSNs", ({ scope, path, list }) => {
  const organization = scope === "organization";

  test("uses regional auth and default options, exposing only public fields", async () => {
    const { requests, projectIds } = mockKeys(() =>
      keysResponse([
        projectKey(),
        { ...projectKey(1), isActive: false, dateCreated: null },
        { ...projectKey(2), projectId: 7, dsn: { public: BACKEND_DSN } },
      ]),
    );

    const result = await list();

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe("GET");
    expect(request.headers.get("Authorization")).toBe("Bearer test-token");
    const url = new URL(request.url);
    expect(`${url.origin}${url.pathname}`).toBe(`https://de.sentry.io${path}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      per_page: "10",
      ...(organization ? { project: "-1" } : {}),
    });
    expect(result.data).toEqual(
      [0, 1, 2].map((index) => ({
        name: `Key ${index}`,
        isActive: index !== 1,
        dateCreated: index === 1 ? null : "2026-01-01T00:00:00Z",
        dsn: index === 2 ? BACKEND_DSN : PUBLIC_DSN,
        ...(organization
          ? { project: index === 2 ? "backend" : "frontend" }
          : {}),
      })),
    );
    expect(projectIds.sort()).toEqual(organization ? ["42", "7"] : []);
  });

  test("forwards page budgets and cursors, reusing project lookups across pages", async () => {
    const { requests, projectIds } = mockKeys((url) => {
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get("project")).toBe(organization ? "-1" : null);
      expect(url.searchParams.has("status")).toBe(false);
      const offset = Number(url.searchParams.get("cursor")?.split(":")[1] ?? 0);
      const count = Math.min(
        Number(url.searchParams.get("per_page")),
        200 - offset,
      );
      return keysResponse(
        Array.from({ length: count }, (_, index) => projectKey(offset + index)),
        offset + count < 200 ? `0:${offset + count}:0` : undefined,
      );
    });

    const first = await list({ limit: 150, cursor: "0:25:0" });
    expect(projectIds).toEqual(organization ? ["42"] : []);
    expect(first.data).toHaveLength(150);
    expect(first.nextCursor).toBe("0:175:0");
    const second = await list({ limit: 50, cursor: first.nextCursor });

    expect(
      requests.map(({ url }) => {
        const query = new URL(url).searchParams;
        return [query.get("per_page"), query.get("cursor")];
      }),
    ).toEqual([
      ["100", "0:25:0"],
      ["50", "0:125:0"],
      ["50", "0:175:0"],
    ]);
    expect(second.nextCursor).toBeUndefined();
    expect([...first.data, ...second.data].map((key) => key.name)).toEqual(
      Array.from({ length: 175 }, (_, index) => `Key ${index + 25}`),
    );
  });
});

test("org metadata lookup failures surface instead of dropping keys or exposing IDs", async () => {
  globalThis.fetch = mockFetch(async (input, init) => {
    const url = new URL(new Request(input!, init).url);
    if (url.pathname === "/api/0/organizations/test-org/project-keys/") {
      return keysResponse([projectKey()]);
    }
    expect(url.pathname).toBe("/api/0/projects/test-org/42/");
    return new Response(JSON.stringify({ detail: "Permission denied" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  });

  await expect(listOrganizationDsns("test-org")).rejects.toBeInstanceOf(
    ApiError,
  );
});
