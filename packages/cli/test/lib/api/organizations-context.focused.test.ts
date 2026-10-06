import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  listOrganizations,
  listOrganizationsUncached,
} from "../../../src/lib/api/organizations.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { getDatabase } from "../../../src/lib/db/index.js";
import {
  clearOrgRegions,
  getCachedOrganizations,
  getOrgRegion,
  setOrgRegions,
} from "../../../src/lib/db/regions.js";
import {
  disableResponseCache,
  resetCacheState,
  storeCachedResponse,
} from "../../../src/lib/response-cache.js";
import { resetAuthenticatedFetch } from "../../../src/lib/sentry-client.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("organizations-context-focused-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_CLIENT_ID",
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
      "SENTRY_CLIENT_ID",
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
            },
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
      },
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
        identity("first-page-token"),
      ),
    ).toBe("https://de.sentry.io");
    expect(
      getOrgRegion(
        "page-two",
        "https://sentry.io",
        identity("concurrent-login-token"),
      ),
    ).toBeUndefined();
  });

  test("keeps organization pages pinned through rotating OAuth refresh tokens", async () => {
    process.env.SENTRY_CLIENT_ID = "test-client-id";
    setAuthToken("initial-access", 3600, "initial-refresh", {
      host: "https://sentry.io",
    });
    const requests = { refreshes: 0, pages: 0 };
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/oauth/token/")) {
          requests.refreshes += 1;
          return Response.json({
            access_token: `rotated-access-${requests.refreshes}`,
            refresh_token: `rotated-refresh-${requests.refreshes}`,
            expires_in: 3600,
            token_type: "bearer",
          });
        }
        if (request.headers.get("authorization") === "Bearer initial-access") {
          return new Response(null, { status: 401 });
        }
        requests.pages += 1;
        expect(request.headers.get("authorization")).toBe(
          `Bearer rotated-access-${requests.refreshes}`,
        );
        return Response.json(
          [
            {
              id: String(requests.pages),
              slug: `rotating-org-${requests.pages}`,
              name: "Rotating",
            },
          ],
          requests.pages === 1
            ? {
                headers: {
                  Link: '<https://sentry.io/api/0/organizations/?cursor=next>; rel="next"; results="true"; cursor="next"',
                },
              }
            : undefined,
        );
      },
    );

    const orgs = await listOrganizationsUncached();
    expect(orgs.map((org) => org.slug)).toEqual([
      "rotating-org-1",
      "rotating-org-2",
    ]);
    expect(requests).toEqual({ refreshes: 2, pages: 2 });
  });

  test("captures credentials before the initial cache lookup", async () => {
    setAuthToken("first", undefined, undefined, { host: "https://sentry.io" });
    const authorization: Array<string | null> = [];
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        authorization.push(
          new Request(input, init).headers.get("authorization"),
        );
        return Response.json([]);
      },
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
      ]),
    );
    await listOrganizationsUncached();
    expect(
      getOrgRegion("malformed-region", "https://sentry.io", identity(token)),
    ).toBeUndefined();
  });

  test("an invalid region among valid siblings never makes a partial org list authoritative", async () => {
    const token = "mixed-region-token";
    setAuthToken(token, undefined, undefined, { host: "https://sentry.io" });
    const requests = { count: 0 };
    globalThis.fetch = vi.fn(async () => {
      requests.count += 1;
      return Response.json(
        requests.count === 1
          ? [{ id: "11", slug: "valid-org", name: "Valid" }]
          : [
              { id: "11", slug: "valid-org", name: "Valid" },
              {
                id: "12",
                slug: "invalid-org",
                name: "Invalid Region",
                links: { regionUrl: "ftp://region.example.com" },
              },
            ],
      );
    });

    expect((await listOrganizationsUncached()).map((org) => org.slug)).toEqual([
      "valid-org",
    ]);
    setOrgRegions([
      {
        slug: "foreign-org",
        regionUrl: "https://sentry.io",
        cacheOrigin: "https://sentry.io",
        identity: identity("another-token"),
        orgId: "99",
        orgName: "Other",
      },
    ]);
    expect((await listOrganizationsUncached()).map((org) => org.slug)).toEqual([
      "valid-org",
      "invalid-org",
    ]);
    expect(
      getOrgRegion("invalid-org", "https://sentry.io", identity(token)),
    ).toBeUndefined();
    expect(
      getOrgRegion("valid-org", "https://sentry.io", identity(token)),
    ).toBe("https://sentry.io");
    expect(
      getCachedOrganizations("https://sentry.io", identity(token)),
    ).toEqual([]);
    expect(
      getCachedOrganizations(
        "https://sentry.io",
        identity("another-token"),
      ).map((org) => org.slug),
    ).toEqual(["foreign-org"]);
    expect((await listOrganizations()).map((org) => org.slug)).toEqual([
      "valid-org",
      "invalid-org",
    ]);
    expect(requests.count).toBe(3);
  });

  test("an empty live org list invalidates previously cached membership", async () => {
    const token = "empty-region-token";
    setAuthToken(token, undefined, undefined, { host: "https://sentry.io" });
    const requests = { count: 0 };
    globalThis.fetch = vi.fn(async () => {
      requests.count += 1;
      return Response.json(
        requests.count === 1
          ? [{ id: "13", slug: "former-org", name: "Former" }]
          : [],
      );
    });

    await listOrganizationsUncached();
    expect(
      getCachedOrganizations("https://sentry.io", identity(token)),
    ).toHaveLength(1);
    await expect(listOrganizationsUncached()).resolves.toEqual([]);
    await expect(listOrganizations()).resolves.toEqual([]);
    expect(requests.count).toBe(3);
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
          "SELECT source_origin, response_origin, region_url FROM org_regions WHERE credential_identity = ? AND org_slug = ?",
        )
        .get(identity("redirect-provenance-token"), "redirected-org"),
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
      ]),
    );

    await listOrganizationsUncached();
    expect(
      getOrgRegion(
        "path-region-org",
        "https://sentry.example.com",
        identity("path-region-token"),
      ),
    ).toBe("https://sentry.example.com/sentry");
  });

  test("keeps the installation path when organization metadata omits regionUrl", async () => {
    process.env.SENTRY_URL = "https://sentry.example.com/sentry";
    setAuthToken("pathless-region-token", undefined, undefined, {
      host: "https://sentry.example.com",
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json([{ id: "6", slug: "pathless-org", name: "Pathless" }]),
    );

    await listOrganizationsUncached();
    expect(
      getOrgRegion(
        "pathless-org",
        "https://sentry.example.com",
        identity("pathless-region-token"),
      ),
    ).toBe("https://sentry.example.com/sentry");
  });

  test("a failed later page never makes an incomplete organization cache authoritative", async () => {
    setAuthToken("partial-page-token", undefined, undefined, {
      host: "https://sentry.io",
    });
    const requests = { count: 0 };
    globalThis.fetch = vi.fn(async () => {
      requests.count += 1;
      if (requests.count === 1) {
        return Response.json(
          [{ id: "7", slug: "partial-org", name: "Partial" }],
          {
            headers: {
              Link: '<https://sentry.io/api/0/organizations/?cursor=next>; rel="next"; results="true"; cursor="next"',
            },
          },
        );
      }
      if (requests.count <= 4) {
        throw new Error("later page failed");
      }
      return Response.json([
        { id: "8", slug: "complete-org", name: "Complete" },
      ]);
    });

    await expect(listOrganizationsUncached()).rejects.toThrow(
      "Failed to list organizations",
    );
    expect(
      getOrgRegion(
        "partial-org",
        "https://sentry.io",
        identity("partial-page-token"),
      ),
    ).toBeUndefined();
    expect((await listOrganizations()).map((org) => org.slug)).toEqual([
      "complete-org",
    ]);
    expect(requests.count).toBe(5);
  });

  test("discovery fetches a fresh response instead of trusting an unstamped HTTP cache hit", async () => {
    const token = "http-cache-discovery-token";
    setAuthToken(token, undefined, undefined, { host: "https://sentry.io" });
    resetCacheState();
    await storeCachedResponse(
      "GET",
      "https://sentry.io/api/0/organizations/?per_page=100",
      { authorization: `Bearer ${token}` },
      Response.json([{ id: "9", slug: "cached-org", name: "Cached" }], {
        headers: { "Cache-Control": "public, max-age=300" },
      }),
      identity(token),
    );
    globalThis.fetch = vi.fn(async () =>
      Response.json([{ id: "10", slug: "fresh-org", name: "Fresh" }]),
    );

    const organizations = await listOrganizationsUncached();
    expect(organizations.map((org) => org.slug)).toEqual(["fresh-org"]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(
      getOrgRegion("fresh-org", "https://sentry.io", identity(token)),
    ).toBe("https://sentry.io");
  });
});
