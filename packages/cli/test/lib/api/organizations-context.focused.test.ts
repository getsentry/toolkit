import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  listOrganizations,
  listOrganizationsUncached,
} from "../../../src/lib/api/organizations.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { getDatabase } from "../../../src/lib/db/index.js";
import { clearOrgRegions, getOrgRegion } from "../../../src/lib/db/regions.js";
import {
  disableResponseCache,
  resetCacheState,
} from "../../../src/lib/response-cache.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("organizations-context-focused-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_HOST",
  "SENTRY_URL",
]);
const originalFetch = globalThis.fetch;

function identity(token: string): string {
  return createHash("sha256")
    .update("oauth-access")
    .update("\0")
    .update(token)
    .digest("hex");
}

describe("organization discovery credential context", () => {
  beforeEach(() => {
    for (const key of [
      "SENTRY_AUTH_TOKEN",
      "SENTRY_TOKEN",
      "SENTRY_FORCE_ENV_TOKEN",
      "SENTRY_HOST",
      "SENTRY_URL",
    ]) {
      delete process.env[key];
    }
    disableResponseCache();
    clearOrgRegions();
    resetAuthenticatedFetch();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetCacheState();
    resetAuthenticatedFetch();
  });

  test("pins one credential across every pagination page", async () => {
    setAuthToken("first-page-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    const authorization: Array<string | null> = [];
    const requests = { count: 0 };
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        authorization.push(request.headers.get("authorization"));
        requests.count += 1;
        if (requests.count === 1) {
          setAuthToken("concurrent-login-token", undefined, undefined, {
            host: "https://sentry.io",
          });
          return Response.json(
            [
              {
                id: "1",
                slug: "page-one",
                name: "Page One",
                links: { regionUrl: "https://us.sentry.io" },
              },
            ],
            {
              headers: {
                Link: '<https://sentry.io/api/0/organizations/?cursor=next>; rel="next"; results="true"; cursor="next"',
              },
            }
          );
        }
        return Response.json([
          {
            id: "2",
            slug: "page-two",
            name: "Page Two",
            links: { regionUrl: "https://de.sentry.io" },
          },
        ]);
      }
    );

    const organizations = await listOrganizationsUncached();
    expect(organizations.map((org) => org.slug)).toEqual([
      "page-one",
      "page-two",
    ]);
    expect(authorization).toEqual([
      "Bearer first-page-token",
      "Bearer first-page-token",
    ]);
    expect(
      getOrgRegion(
        "page-two",
        "https://sentry.io",
        identity("first-page-token")
      )
    ).toBe("https://de.sentry.io");
    expect(
      getOrgRegion(
        "page-two",
        "https://sentry.io",
        identity("concurrent-login-token")
      )
    ).toBeUndefined();
  });

  test("captures credentials before the initial cache lookup", async () => {
    setAuthToken("first", undefined, undefined, { host: "https://sentry.io" });
    const authorization: Array<string | null> = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        authorization.push(
          new Request(input, init).headers.get("authorization")
        );
        return Response.json([]);
      }
    );
    const pending = listOrganizations();
    setAuthToken("second", undefined, undefined, { host: "https://sentry.io" });
    await expect(pending).resolves.toEqual([]);
    expect(authorization).toEqual(["Bearer first"]);
  });

  test.each([
    "ftp://region.example.com",
    "https://user:password@region.example.com",
    "not a URL",
  ])("never persists malformed region metadata %s", async (regionUrl) => {
    const token = `malformed-${createHash("sha256").update(regionUrl).digest("hex")}`;
    setAuthToken(token, undefined, undefined, { host: "https://sentry.io" });
    globalThis.fetch = vi.fn(async () =>
      Response.json([
        {
          id: "3",
          slug: "malformed-region",
          name: "Malformed Region",
          links: { regionUrl },
        },
      ])
    );
    await listOrganizationsUncached();
    expect(
      getOrgRegion("malformed-region", "https://sentry.io", identity(token))
    ).toBeUndefined();
  });

  test("persists the exact validated final response origin", async () => {
    setAuthToken("redirect-provenance-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    const requests = { count: 0 };
    globalThis.fetch = vi.fn(async () => {
      requests.count += 1;
      return requests.count === 1
        ? Response.redirect("https://de.sentry.io/api/0/organizations/", 307)
        : Response.json([
            {
              id: "4",
              slug: "redirected-org",
              name: "Redirected Organization",
              links: { regionUrl: "https://eu.sentry.io" },
            },
          ]);
    });
    await listOrganizationsUncached();
    expect(
      getDatabase()
        .query(
          "SELECT source_origin, response_origin, region_url FROM org_regions WHERE credential_identity = ? AND org_slug = ?"
        )
        .get(identity("redirect-provenance-token"), "redirected-org")
    ).toEqual({
      source_origin: "https://sentry.io",
      response_origin: "https://de.sentry.io",
      region_url: "https://eu.sentry.io",
    });
  });

  test("keeps a self-hosted installation path in organization region metadata", async () => {
    setAuthToken("path-region-token", undefined, undefined, {
      host: "https://sentry.example.com",
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json([
        {
          id: "5",
          slug: "path-region-org",
          name: "Path Region",
          links: { regionUrl: "https://sentry.example.com/sentry/" },
        },
      ])
    );

    await listOrganizationsUncached();
    expect(
      getOrgRegion(
        "path-region-org",
        "https://sentry.example.com",
        identity("path-region-token")
      )
    ).toBe("https://sentry.example.com/sentry");
  });

  test("keeps the installation path when organization metadata omits regionUrl", async () => {
    process.env.SENTRY_URL = "https://sentry.example.com/sentry";
    setAuthToken("pathless-region-token", undefined, undefined, {
      host: "https://sentry.example.com",
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json([{ id: "6", slug: "pathless-org", name: "Pathless" }])
    );

    await listOrganizationsUncached();
    expect(
      getOrgRegion(
        "pathless-org",
        "https://sentry.example.com",
        identity("pathless-region-token")
      )
    ).toBe("https://sentry.example.com/sentry");
  });
});
