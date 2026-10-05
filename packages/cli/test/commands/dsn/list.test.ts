/** DSN listing contracts through the real command, SDK, and cursor storage. */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildApplication, ExitCode, run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { dsnRoute } from "../../../src/commands/dsn/index.js";
import { listCommand } from "../../../src/commands/dsn/list.js";
import type { SentryContext } from "../../../src/context.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import {
  setDefaultOrganization,
  setDefaultProject,
} from "../../../src/lib/db/defaults.js";
import { clearOrgRegions, setOrgRegions } from "../../../src/lib/db/regions.js";
import { ApiError } from "../../../src/lib/errors.js";
import {
  disableResponseCache,
  resetCacheState,
} from "../../../src/lib/response-cache.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { mockProcess } from "../../fixture.js";
import { mockFetch, useEnvSandbox, useTestConfigDir } from "../../helpers.js";

useEnvSandbox([
  "SENTRY_ORG",
  "SENTRY_PROJECT",
  "SENTRY_DSN",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_URL",
  "SENTRY_HOST",
]);
const configDir = useTestConfigDir("dsn-list-", { isolateProjectRoot: true });
const PROJECT_API_PATH = /^\/api\/0\/projects\/([^/]+)\/([^/]+)\/(keys\/)?$/;
const PUBLIC_DSN = `https://${"a".repeat(32)}@o1.ingest.us.sentry.io/42`;
const KEY = {
  id: "internal-key-id",
  projectId: 42,
  public: "standalone-public-key",
  secret: "private-key",
  useCase: "internal-purpose",
  name: "Browser",
  isActive: true,
  dateCreated: "2026-01-01T00:00:00Z",
  dsn: { public: PUBLIC_DSN, secret: "private-dsn", csp: "other-endpoint" },
};

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  resetCacheState();
  disableResponseCache();
  resetAuthenticatedFetch();
  setAuthToken("test-token");
  setOrgRegions([
    {
      slug: "test-org",
      regionUrl: "https://us.sentry.io",
      orgId: "1",
      orgName: "Test Org",
    },
  ]);
  setDefaultOrganization("test-org");
  setDefaultProject("test-project");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetCacheState();
  resetAuthenticatedFetch();
});

function createContext() {
  const mock = mockProcess();
  const context: SentryContext = {
    configDir: configDir(),
    cwd: configDir(),
    env: process.env,
    homeDir: configDir(),
    process,
    stdin: process.stdin,
    stdout: mock.process.stdout,
    stderr: mock.process.stderr,
  };
  return {
    context,
    output: () => mock.output.stdout,
    diagnostics: () => mock.output.stderr,
  };
}

function response(body: unknown, nextCursor?: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(nextCursor
        ? {
            Link: `<https://us.sentry.io/api/0/>; rel="next"; results="true"; cursor="${nextCursor}"`,
          }
        : {}),
    },
  });
}

/** Project metadata served by the real SDK's HTTP boundary. */
function project(org: string, orgId: string, slug: string, id: string) {
  return { id, slug, name: slug, organization: { id: orgId, slug: org } };
}

type Project = ReturnType<typeof project>;
const CROSS_ORG_PROJECTS = [
  project("org-one", "1", "frontend", "42"),
  project("org-two", "2", "frontend", "43"),
];
const DEFAULT_PROJECTS = [
  project("test-org", "1", "test-project", "42"),
  project("test-org", "1", "other-project", "43"),
];

/** Serve organization discovery and project metadata before the key endpoint. */
function mockProjectApi(
  projects: Project[],
  fetchKeys: (target: Project, url: URL) => Response
) {
  return mockFetch(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const organizations = [
      ...new Map(
        projects.map((item) => [item.organization.slug, item.organization])
      ).values(),
    ].map((org) => ({
      ...org,
      name: org.slug,
      links: { regionUrl: "https://us.sentry.io" },
    }));
    if (url.pathname === "/api/0/organizations/") {
      return response(organizations);
    }
    for (const org of organizations) {
      if (
        [org.slug, org.id, `o${org.id}`].some(
          (value) => url.pathname === `/api/0/organizations/${value}/`
        )
      ) {
        return response(org);
      }
    }
    const match = PROJECT_API_PATH.exec(url.pathname);
    if (match) {
      const target = projects.find(
        (item) =>
          [
            item.organization.slug,
            item.organization.id,
            `o${item.organization.id}`,
          ].includes(match[1] ?? "") &&
          [item.slug, item.id].includes(match[2] ?? "")
      );
      if (target) {
        return match[3] ? fetchKeys(target, url) : response(target);
      }
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
}

/** Deterministic API pages whose cursors advance by the requested item count. */
function keyPage(target: Project, url: URL, count: number) {
  const offset = Number(url.searchParams.get("cursor")?.split(":")[1] ?? 0);
  const limit = Number(url.searchParams.get("per_page"));
  const keys = Array.from({ length: count }, (_, index) => ({
    ...KEY,
    projectId: Number(target.id),
    name: `${target.organization.slug}/${target.slug} ${index + 1}`,
    dsn: {
      public: `https://${"a".repeat(32)}@o${target.organization.id}.ingest.us.sentry.io/${target.id}`,
    },
  }));
  const next = offset + limit;
  return response(
    keys.slice(offset, next),
    next < count ? `0:${next}:0` : undefined
  );
}

function cacheOrganizations(projects: Project[]) {
  clearOrgRegions();
  setOrgRegions(
    projects.map(({ organization }) => ({
      slug: organization.slug,
      orgId: organization.id,
      orgName: organization.slug,
      regionUrl: "https://us.sentry.io",
    }))
  );
}

async function invoke(
  options: {
    target?: string;
    json?: boolean;
    limit?: number;
    cursor?: string;
    fields?: string[];
  } = {}
) {
  const ctx = createContext();
  const func = await listCommand.loader();
  await func.call(
    ctx.context,
    {
      json: options.json ?? true,
      fresh: false,
      limit: options.limit ?? 25,
      cursor: options.cursor,
      fields: options.fields,
    },
    options.target
  );
  return ctx;
}

async function invokeJson(options?: Parameters<typeof invoke>[0]) {
  return JSON.parse((await invoke(options)).output());
}

describe("dsn list", () => {
  test("lists a bare project across organizations with a global limit and resumable exhausted targets", async () => {
    const projects = CROSS_ORG_PROJECTS;
    cacheOrganizations(projects);
    globalThis.fetch = mockProjectApi(projects, (target, url) =>
      keyPage(target, url, target.organization.slug === "org-one" ? 5 : 1)
    );

    const first = await invokeJson({ target: "frontend", limit: 4 });
    expect(first.data).toHaveLength(4);
    expect(first.data.map((item: { name: string }) => item.name)).toEqual(
      expect.arrayContaining([
        "org-one/frontend 1",
        "org-one/frontend 2",
        "org-one/frontend 3",
        "org-two/frontend 1",
      ])
    );
    expect(first).toMatchObject({ hasMore: true, hasPrev: false });

    const next = await invokeJson({
      target: "frontend",
      limit: 4,
      cursor: "next",
    });
    expect(next.data.map((item: { name: string }) => item.name)).toEqual([
      "org-one/frontend 4",
      "org-one/frontend 5",
    ]);
    expect(next).toMatchObject({ hasMore: false, hasPrev: true });
    expect(
      await invokeJson({ target: "frontend", limit: 4, cursor: "prev" })
    ).toEqual(first);
  });

  test.each([
    true,
    false,
  ])("detects all monorepo projects with public slugs from cold caches (json=%s)", async (json) => {
    const projects = [
      project("test-org", "1", "frontend", "42"),
      project("test-org", "1", "backend", "43"),
    ];
    setDefaultOrganization(null);
    setDefaultProject(null);
    clearOrgRegions();
    await writeFile(
      join(configDir(), "package.json"),
      JSON.stringify({ private: true, workspaces: ["apps/*"] })
    );
    for (const target of projects) {
      const directory = join(configDir(), "apps", target.slug);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, ".env"),
        `SENTRY_DSN=https://${"a".repeat(32)}@o1.ingest.us.sentry.io/${target.id}\n`
      );
    }
    globalThis.fetch = mockProjectApi(projects, (target, url) =>
      keyPage(target, url, 2)
    );

    const first = await invoke({ limit: 2, json });
    if (json) {
      const result = JSON.parse(first.output());
      expect(result).toMatchObject({ hasMore: true, hasPrev: false });
      expect(result.data).toHaveLength(2);
      expect(result.data).toEqual(
        expect.arrayContaining(
          projects.map((target) => ({
            org: "test-org",
            project: target.slug,
            name: `test-org/${target.slug} 1`,
            isActive: true,
            dateCreated: KEY.dateCreated,
            dsn: `https://${"a".repeat(32)}@o1.ingest.us.sentry.io/${target.id}`,
          }))
        )
      );
    } else {
      expect(first.output()).toContain("test-org/frontend");
      expect(first.output()).toContain("test-org/backend");
    }
    expect(`${first.output()}\n${first.diagnostics()}`).not.toMatch(
      /\b(?:test-org|1)\s*\/\s*(?:42|43)\b|\b1\s*\/\s*(?:frontend|backend)\b/
    );

    // The cold listing populated the cache; navigation must keep the same history.
    const next = await invokeJson({ limit: 2, cursor: "next" });
    expect(next).toMatchObject({ hasMore: false, hasPrev: true });
    expect(next.data.map((item: { name: string }) => item.name)).toEqual(
      expect.arrayContaining(["test-org/frontend 2", "test-org/backend 2"])
    );
    expect(next.data).toHaveLength(2);
    const previous = await invokeJson({ limit: 2, cursor: "prev" });
    expect(previous.data.map((item: { name: string }) => item.name)).toEqual(
      expect.arrayContaining(["test-org/frontend 1", "test-org/backend 1"])
    );
    expect(previous).toMatchObject({ hasMore: true, hasPrev: false });
  });

  test("explains when detected DSNs cannot be resolved", async () => {
    setDefaultOrganization(null);
    setDefaultProject(null);
    await writeFile(
      join(configDir(), ".env"),
      `SENTRY_DSN=https://${"a".repeat(32)}@sentry.example.com/42\n`
    );
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/api/0/users/me/regions/") {
        return response({ regions: [] });
      }
      expect(url.pathname).toBe("/api/0/projects/");
      expect(url.searchParams.get("query")).toBe(`dsn:${"a".repeat(32)}`);
      return response([]);
    });
    await expect(invoke()).rejects.toMatchObject({
      name: "ContextError",
      command: "sentry dsn list <org>/<project>",
      message: expect.stringContaining(
        "Found 1 DSN(s) that could not be resolved — you may not have access to these projects"
      ),
    });
  });

  test.each([
    false,
    true,
  ])("surfaces failed projects without treating them as empty (allDenied=%s)", async (allDenied) => {
    const projects = CROSS_ORG_PROJECTS;
    cacheOrganizations(projects);
    globalThis.fetch = mockProjectApi(projects, (target, url) => {
      if (allDenied || target.organization.slug === "org-two") {
        return response({ detail: "Permission denied" }, undefined, 403);
      }
      return keyPage(target, url, 1);
    });
    if (allDenied) {
      await expect(invoke({ target: "frontend" })).rejects.toThrow(ApiError);
      return;
    }
    const result = await invokeJson({ target: "frontend", limit: 4 });
    expect(result.data).toMatchObject([
      { org: "org-one", project: "frontend", name: "org-one/frontend 1" },
    ]);
    expect(result.errors).toMatchObject([
      { project: "org-two/frontend", status: 403 },
    ]);
  });

  test("does not advertise an unsafe cursor when the limit cannot include every target", async () => {
    const projects = CROSS_ORG_PROJECTS;
    cacheOrganizations(projects);
    globalThis.fetch = mockProjectApi(projects, (target, url) =>
      keyPage(target, url, 2)
    );
    const result = await invokeJson({ target: "frontend", limit: 1 });
    expect(result.data).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBeUndefined();
    await expect(
      invoke({ target: "frontend", limit: 1, cursor: "next" })
    ).rejects.toThrow("No next page");
  });

  test("returns an empty organization page without project lookups", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      expect(new URL(new Request(input, init).url).pathname).toBe(
        "/api/0/organizations/test-org/project-keys/"
      );
      return response([]);
    });
    expect(await invokeJson({ target: "test-org/" })).toEqual({
      data: [],
      hasMore: false,
      hasPrev: false,
    });
  });

  test.each([
    "0",
    "1001",
  ])("rejects --limit %s before any API call", async (limit) => {
    const fetch = vi.fn(mockFetch(async () => response([])));
    globalThis.fetch = fetch;
    const ctx = createContext();
    const cliProcess = { ...process, exitCode: undefined };
    await run(
      buildApplication(dsnRoute, { name: "sentry dsn" }),
      ["list", "test-org/", "--limit", limit],
      { ...ctx.context, process: cliProcess }
    );
    expect(cliProcess.exitCode).toBe(ExitCode.InvalidArgument);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("ls honors an explicit project over defaults and exposes only public JSON fields", async () => {
    globalThis.fetch = mockProjectApi(DEFAULT_PROJECTS, (_target, url) => {
      expect(url.pathname).toBe("/api/0/projects/test-org/other-project/keys/");
      return response([KEY]);
    });
    const ctx = createContext();
    await run(
      buildApplication(dsnRoute, { name: "sentry dsn" }),
      ["ls", "test-org/other-project", "--json"],
      ctx.context
    );
    expect(JSON.parse(ctx.output())).toEqual({
      data: [
        {
          org: "test-org",
          project: "other-project",
          name: "Browser",
          isActive: true,
          dateCreated: KEY.dateCreated,
          dsn: PUBLIC_DSN,
        },
      ],
      hasMore: false,
      hasPrev: false,
    });
    const filtered = await invokeJson({
      target: "test-org/other-project",
      fields: ["dsn"],
    });
    expect(filtered.data).toEqual([{ dsn: PUBLIC_DSN }]);
  });

  test("shows public DSNs, enabled status, and missing creation dates in human output", async () => {
    globalThis.fetch = mockProjectApi(DEFAULT_PROJECTS, () =>
      response([
        KEY,
        { ...KEY, name: "Old browser", isActive: false, dateCreated: null },
      ])
    );
    const ctx = await invoke({ json: false, target: "test-org/test-project" });
    for (const visible of [
      "test-org/test-project",
      "Browser",
      "Enabled",
      "Disabled",
      "—",
      PUBLIC_DSN,
    ]) {
      expect(ctx.output()).toContain(visible);
    }
    expect(ctx.output()).not.toMatch(
      /internal-key-id|private-key|private-dsn|internal-purpose/
    );
  });

  test("a bare name prefers the matching project over an organization", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path === "/api/0/projects/test-org/test-org/") {
        return response({ id: "42", slug: "test-org", name: "Test Org" });
      }
      expect(path).toBe("/api/0/projects/test-org/test-org/keys/");
      return response([KEY]);
    });
    const result = await invokeJson({ target: "test-org" });
    expect(result.data).toMatchObject([
      { org: "test-org", project: "test-org", name: KEY.name },
    ]);
  });

  test("bare org and org/ share multi-project listing and next/prev history", async () => {
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === "/api/0/projects/test-org/test-org/") {
        return response({ detail: "Not found" }, undefined, 404);
      }
      const target = DEFAULT_PROJECTS.find(
        (item) => url.pathname === `/api/0/projects/test-org/${item.id}/`
      );
      if (target) {
        return response(target);
      }
      if (url.pathname === "/api/0/projects/test-org/test-project/") {
        return response(DEFAULT_PROJECTS[0]);
      }
      expect(url.pathname).toBe("/api/0/organizations/test-org/project-keys/");
      expect(url.searchParams.get("per_page")).toBe("2");
      return url.searchParams.get("cursor") === "next:0:0"
        ? response([{ ...KEY, name: "Second" }])
        : response([KEY, { ...KEY, projectId: 43 }], "next:0:0");
    });
    const first = await invokeJson({ target: "test-org", limit: 2 });
    expect(first).toMatchObject({
      data: [
        { org: "test-org", project: "test-project" },
        { org: "test-org", project: "other-project" },
      ],
      hasMore: true,
      hasPrev: false,
    });
    const next = await invokeJson({
      target: "test-org/",
      limit: 2,
      cursor: "next",
    });
    expect(next).toMatchObject({
      data: [{ name: "Second", org: "test-org", project: "test-project" }],
      hasMore: false,
      hasPrev: true,
    });
    const prev = await invokeJson({
      target: "test-org",
      limit: 2,
      cursor: "prev",
    });
    expect(prev).toEqual(first);
    await expect(
      invoke({ target: "test-org/test-project", limit: 2, cursor: "next" })
    ).rejects.toThrow("No next page");
  });

  test("uses the configured project and scopes its pagination history to project and page size", async () => {
    globalThis.fetch = mockProjectApi(DEFAULT_PROJECTS, (target, url) =>
      keyPage(target, url, 2)
    );
    const first = await invokeJson({ limit: 1 });
    expect(first).toMatchObject({
      hasMore: true,
      hasPrev: false,
      nextCursor: "0:1:0",
      data: [{ org: "test-org", project: "test-project" }],
    });
    const second = await invokeJson({ limit: 1, cursor: "next" });
    expect(second).toMatchObject({
      data: [{ name: "test-org/test-project 2" }],
      hasMore: false,
      hasPrev: true,
    });
    const previous = await invokeJson({ limit: 1, cursor: "prev" });
    expect(previous).toEqual(first);
    await expect(
      invoke({ target: "test-org/other-project", limit: 1, cursor: "next" })
    ).rejects.toThrow("No next page");
    await expect(
      invoke({ target: "test-org/test-project", limit: 2, cursor: "next" })
    ).rejects.toThrow("No next page");
  });
});
