/**
 * Multi-Region API Client Tests
 *
 * Tests for the multi-region support in the Sentry API client.
 * Covers region discovery, fan-out, and region-aware routing.
 */

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as Sentry from "@sentry/node";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  findProjectByDsn,
  getUserRegions,
  listOrganizations,
  listOrganizationsPage,
} from "../../src/lib/api-client.js";
import { setAuthToken } from "../../src/lib/db/auth.js";
import {
  clearOrgRegions,
  getAllOrgRegions,
  setOrgRegion,
} from "../../src/lib/db/regions.js";
import { ApiError } from "../../src/lib/errors.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("test-multiregion-");
let originalFetch: typeof globalThis.fetch;
let savedAuthToken: string | undefined;
let savedSentryToken: string | undefined;

beforeEach(async () => {
  // Save original fetch
  originalFetch = globalThis.fetch;

  // Isolate from env-var auth tokens so isEnvTokenActive() returns false.
  // Without this, tests for 403 enrichment would flake when CI sets
  // SENTRY_AUTH_TOKEN (the error message changes based on token source).
  savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
  savedSentryToken = process.env.SENTRY_TOKEN;
  delete process.env.SENTRY_AUTH_TOKEN;
  delete process.env.SENTRY_TOKEN;

  // Set up auth token (manual token, no refresh)
  setAuthToken("test-token");

  // Clear any existing region cache
  clearOrgRegions();
});

afterEach(() => {
  // Restore original fetch
  globalThis.fetch = originalFetch;

  // Restore env vars
  if (savedAuthToken !== undefined) {
    process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
  }
  if (savedSentryToken !== undefined) {
    process.env.SENTRY_TOKEN = savedSentryToken;
  }
});

/**
 * Creates a mock fetch that routes requests based on URL patterns.
 */
function createMultiRegionMockFetch(handlers: {
  controlSilo?: (req: Request) => Response | Promise<Response>;
  usRegion?: (req: Request) => Response | Promise<Response>;
  euRegion?: (req: Request) => Response | Promise<Response>;
  default?: (req: Request) => Response | Promise<Response>;
}): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);

    // Route to appropriate handler based on hostname
    if (
      url.hostname === "sentry.io" ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1"
    ) {
      if (handlers.controlSilo) {
        return await handlers.controlSilo(req);
      }
    } else if (url.hostname === "us.sentry.io") {
      if (handlers.usRegion) {
        return await handlers.usRegion(req);
      }
    } else if (url.hostname === "de.sentry.io" && handlers.euRegion) {
      return await handlers.euRegion(req);
    }

    if (handlers.default) {
      return await handlers.default(req);
    }

    return new Response(JSON.stringify({ detail: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("getUserRegions", () => {
  test("returns regions from control silo", async () => {
    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: (req) => {
        if (req.url.includes("/users/me/regions/")) {
          return new Response(
            JSON.stringify({
              regions: [
                { name: "us", url: "https://us.sentry.io" },
                { name: "de", url: "https://de.sentry.io" },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
        });
      },
    });

    const regions = await getUserRegions();

    expect(regions).toHaveLength(2);
    expect(regions[0]).toEqual({ name: "us", url: "https://us.sentry.io" });
    expect(regions[1]).toEqual({ name: "de", url: "https://de.sentry.io" });
  });

  test("returns empty array when no regions", async () => {
    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: (req) => {
        if (req.url.includes("/users/me/regions/")) {
          return new Response(
            JSON.stringify({
              regions: [],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
        });
      },
    });

    const regions = await getUserRegions();

    expect(regions).toHaveLength(0);
  });

  test("returns single region for self-hosted", async () => {
    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: (req) => {
        if (req.url.includes("/users/me/regions/")) {
          return new Response(
            JSON.stringify({
              regions: [{ name: "monolith", url: "https://sentry.io" }],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(JSON.stringify({ detail: "Not found" }), {
          status: 404,
        });
      },
    });

    const regions = await getUserRegions();

    expect(regions).toHaveLength(1);
    expect(regions[0]).toEqual({ name: "monolith", url: "https://sentry.io" });
  });
});

describe("listOrganizationsPage", () => {
  test("fetches organizations from a specific base URL", async () => {
    let capturedUrl: string | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      capturedUrl = req.url;

      return new Response(
        JSON.stringify([
          { id: "1", slug: "us-org-1", name: "US Org 1" },
          { id: "2", slug: "us-org-2", name: "US Org 2" },
        ]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const { data: orgs } = await listOrganizationsPage("https://us.sentry.io");

    expect(capturedUrl).toContain("us.sentry.io");
    expect(capturedUrl).toContain("/api/0/organizations/");
    expect(orgs).toHaveLength(2);
    expect(orgs[0].slug).toBe("us-org-1");
  });

  test("enriches 403 error with re-auth guidance for OAuth users", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "You do not have permission" }), {
        status: 403,
        statusText: "Forbidden",
        headers: { "Content-Type": "application/json" },
      });

    try {
      await listOrganizationsPage("https://us.sentry.io");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiErr = error as ApiError;
      expect(apiErr.status).toBe(403);
      // Should include the original detail
      expect(apiErr.detail).toContain("You do not have permission");
      // OAuth users: suggest re-auth (not token scopes)
      expect(apiErr.detail).toContain("sentry auth login");
      expect(apiErr.detail).not.toContain("org:read");
    }
  });

  test("handles base URL with trailing slash", async () => {
    let capturedUrl: string | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      capturedUrl = req.url;

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await listOrganizationsPage("https://de.sentry.io/");

    // Should not have double slashes
    expect(capturedUrl).not.toContain("//api");
    expect(capturedUrl).toContain("de.sentry.io/api/0/organizations/");
  });
});

describe("listOrganizations (control silo)", () => {
  test("fetches all orgs from the control silo in a single call", async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: (req) => {
        requestedUrls.push(req.url);
        return new Response(
          JSON.stringify([
            {
              id: "100",
              slug: "us-org",
              name: "US Organization",
              links: {
                organizationUrl: "https://us.sentry.io/organizations/us-org/",
                regionUrl: "https://us.sentry.io",
              },
            },
            {
              id: "200",
              slug: "eu-org",
              name: "EU Organization",
              links: {
                organizationUrl: "https://de.sentry.io/organizations/eu-org/",
                regionUrl: "https://de.sentry.io",
              },
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });

    const orgs = await listOrganizations();

    // No region discovery call, and only one request to the control silo.
    expect(requestedUrls.some((u) => u.includes("/users/me/regions/"))).toBe(
      false,
    );
    expect(
      requestedUrls.filter((u) => u.includes("/organizations/")),
    ).toHaveLength(1);

    // Both orgs (from different regions) come back from that single call.
    expect(orgs).toHaveLength(2);
    expect(orgs.map((o) => o.slug).sort()).toEqual(["eu-org", "us-org"]);
  });

  test("caches each org's own region URL from links, in one round-trip", async () => {
    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: () =>
        new Response(
          JSON.stringify([
            {
              id: "101",
              slug: "acme-us",
              name: "Acme US",
              links: {
                organizationUrl: "https://us.sentry.io/organizations/acme-us/",
                regionUrl: "https://us.sentry.io",
              },
            },
            {
              id: "201",
              slug: "acme-eu",
              name: "Acme EU",
              links: {
                organizationUrl: "https://de.sentry.io/organizations/acme-eu/",
                regionUrl: "https://de.sentry.io",
              },
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    });

    await listOrganizations();

    // Verify region cache was populated from links in the single response
    const cachedRegions = getAllOrgRegions();
    expect(cachedRegions.size).toBe(2);
    expect(cachedRegions.get("acme-us")).toBe("https://us.sentry.io");
    expect(cachedRegions.get("acme-eu")).toBe("https://de.sentry.io");
  });

  test("returns empty array when the user has no orgs", async () => {
    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    const orgs = await listOrganizations();

    expect(orgs).toHaveLength(0);
  });

  test("falls back to the control silo URL when an org has no links", async () => {
    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: () =>
        new Response(
          JSON.stringify([
            {
              id: "103",
              slug: "org-with-links",
              name: "Org With Links",
              links: {
                organizationUrl:
                  "https://custom.sentry.io/organizations/org-with-links/",
                regionUrl: "https://custom.sentry.io",
              },
            },
            {
              id: "104",
              slug: "org-without-links",
              name: "Org Without Links",
              // No links - should fall back to the control silo URL
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    });

    await listOrganizations();

    const cachedRegions = getAllOrgRegions();
    // Org with links should use its own regionUrl
    expect(cachedRegions.get("org-with-links")).toBe(
      "https://custom.sentry.io",
    );
    // Org without links falls back to the control silo base URL
    expect(cachedRegions.get("org-without-links")).toBe("https://sentry.io");
  });

  test("propagates a 403 error from the control silo", async () => {
    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: () =>
        new Response(JSON.stringify({ detail: "You do not have permission" }), {
          status: 403,
          statusText: "Forbidden",
          headers: { "Content-Type": "application/json" },
        }),
    });

    try {
      await listOrganizations();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiErr = error as ApiError;
      expect(apiErr.status).toBe(403);
      // OAuth users: re-auth guidance (no scope hint)
      expect(apiErr.detail).toContain("sentry auth login");
    }
  });

  test("auto-paginates through multiple pages via the Link header", async () => {
    let callCount = 0;

    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(
            JSON.stringify([{ id: "1", slug: "org-page-1", name: "Page 1" }]),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                Link: '<https://sentry.io/api/0/organizations/>; rel="next"; results="true"; cursor="page2:0:0"',
              },
            },
          );
        }
        return new Response(
          JSON.stringify([{ id: "2", slug: "org-page-2", name: "Page 2" }]),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: '<https://sentry.io/api/0/organizations/>; rel="next"; results="false"; cursor="end:0:0"',
            },
          },
        );
      },
    });

    const orgs = await listOrganizations();

    expect(callCount).toBe(2);
    expect(orgs.map((o) => o.slug).sort()).toEqual([
      "org-page-1",
      "org-page-2",
    ]);
  });
});

// Legacy DSN host with no `o<id>`: the org has to be looked up.
const TEST_DSN = "https://abc123@sentry.io/42";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Orgs from the control silo, each linked to its own region. */
function orgsInRegions(): Response {
  return jsonResponse([
    {
      id: "100",
      slug: "us-org",
      name: "US Organization",
      links: {
        organizationUrl: "https://us.sentry.io/organizations/us-org/",
        regionUrl: "https://us.sentry.io",
      },
    },
    {
      id: "200",
      slug: "eu-org",
      name: "EU Organization",
      links: {
        organizationUrl: "https://de.sentry.io/organizations/eu-org/",
        regionUrl: "https://de.sentry.io",
      },
    },
  ]);
}

const DSN_NOT_FOUND = { detail: "DSN not found" };

const EU_LOOKUP = {
  organizationSlug: "eu-org",
  projectSlug: "eu-project",
  projectId: "300",
  projectName: "EU Project",
  projectPlatform: "python",
  keyLabel: "Default",
  keyId: 7,
};

describe("findProjectByDsn (multi-region)", () => {
  test("asks each org's region with dsn-lookup and returns the match", async () => {
    const requestedUrls: string[] = [];

    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: (req) => {
        requestedUrls.push(req.url);
        return orgsInRegions();
      },
      usRegion: (req) => {
        requestedUrls.push(req.url);
        return jsonResponse(DSN_NOT_FOUND, 404);
      },
      euRegion: (req) => {
        requestedUrls.push(req.url);
        return jsonResponse(EU_LOOKUP);
      },
    });

    const project = await findProjectByDsn(TEST_DSN, "abc123");

    const lookups = requestedUrls
      .map((u) => new URL(u))
      .filter((u) => u.pathname.endsWith("/dsn-lookup/"));
    expect(lookups.map((u) => `${u.origin}${u.pathname}`).sort()).toEqual([
      "https://de.sentry.io/api/0/organizations/eu-org/dsn-lookup/",
      "https://us.sentry.io/api/0/organizations/us-org/dsn-lookup/",
    ]);
    expect(lookups.every((u) => u.searchParams.get("dsn") === TEST_DSN)).toBe(
      true,
    );
    expect(requestedUrls.some((u) => u.includes("/users/me/regions/"))).toBe(
      false,
    );
    expect(project).toEqual({
      id: "300",
      slug: "eu-project",
      name: "EU Project",
      organization: { id: "200", slug: "eu-org", name: "EU Organization" },
    });
  });

  test("returns null without falling back when no org has the DSN", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: (req) => {
        requestedUrls.push(req.url);
        return orgsInRegions();
      },
      default: (req) => {
        requestedUrls.push(req.url);
        return jsonResponse(DSN_NOT_FOUND, 404);
      },
    });

    expect(await findProjectByDsn(TEST_DSN, "abc123")).toBeNull();
    expect(
      requestedUrls.some((u) => new URL(u).pathname === "/api/0/projects/"),
    ).toBe(false);
  });

  test("never falls back to the deprecated /projects/ lookup on SaaS", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: (req) => {
        requestedUrls.push(req.url);
        return orgsInRegions();
      },
      default: (req) => {
        requestedUrls.push(req.url);
        // Catch-all 404: the endpoint doesn't exist on this server.
        return new Response("", { status: 404 });
      },
    });

    expect(await findProjectByDsn(TEST_DSN, "abc123")).toBeNull();
    expect(
      requestedUrls.some((u) => new URL(u).pathname === "/api/0/projects/"),
    ).toBe(false);
  });

  test("reports one org's failure and keeps looking in the others", async () => {
    globalThis.fetch = createMultiRegionMockFetch({
      controlSilo: () => orgsInRegions(),
      usRegion: () => {
        throw new Error("Network error");
      },
      euRegion: () => jsonResponse(EU_LOOKUP),
    });

    const captureSpy = vi.spyOn(Sentry, "captureException");
    const withScopeSpy = vi.spyOn(Sentry, "withScope");
    withScopeSpy.mockImplementation((fn: (scope: unknown) => void) => {
      fn({
        setTag() {
          /* noop */
        },
        setContext() {
          /* noop */
        },
        setFingerprint() {
          /* noop */
        },
      });
    });
    try {
      const project = await findProjectByDsn(TEST_DSN, "abc123");

      expect(project?.slug).toBe("eu-project");
      expect(captureSpy).toHaveBeenCalledTimes(1);
      expect(captureSpy.mock.calls[0]?.[0]).toMatchObject({
        message: "Network error",
      });
    } finally {
      captureSpy.mockRestore();
      withScopeSpy.mockRestore();
    }
  });

  describe("self-hosted", () => {
    const SELF_HOSTED_DSN = "http://shkey@localhost:9000/3";
    let savedUrl: string | undefined;

    beforeEach(() => {
      savedUrl = process.env.SENTRY_URL;
      process.env.SENTRY_URL = "http://localhost:9000";
      setAuthToken("self-hosted-token", undefined, undefined, {
        host: "http://localhost:9000",
      });
    });

    afterEach(() => {
      if (savedUrl === undefined) {
        delete process.env.SENTRY_URL;
      } else {
        process.env.SENTRY_URL = savedUrl;
      }
    });

    /** A self-hosted server: one org, no region links. */
    function selfHostedServer(
      dsnLookup: () => Response,
      requestedUrls: string[],
    ): typeof globalThis.fetch {
      return createMultiRegionMockFetch({
        controlSilo: (req) => {
          requestedUrls.push(req.url);
          const { pathname } = new URL(req.url);
          if (pathname === "/api/0/organizations/") {
            return jsonResponse([{ id: "1", slug: "sentry", name: "Sentry" }]);
          }
          if (pathname.endsWith("/dsn-lookup/")) {
            return dsnLookup();
          }
          if (pathname === "/api/0/projects/") {
            return jsonResponse([
              {
                id: "400",
                slug: "self-hosted-project",
                name: "Self Hosted Project",
                organization: { id: "1", slug: "sentry", name: "Sentry" },
              },
            ]);
          }
          return jsonResponse({ detail: "Not found" }, 404);
        },
      });
    }

    test("falls back to /projects/?query=dsn: when the server has no dsn-lookup", async () => {
      const requestedUrls: string[] = [];
      globalThis.fetch = selfHostedServer(
        () => new Response("", { status: 404 }),
        requestedUrls,
      );

      const project = await findProjectByDsn(SELF_HOSTED_DSN, "shkey");

      expect(project?.slug).toBe("self-hosted-project");
      const fallback = requestedUrls
        .map((u) => new URL(u))
        .find((u) => u.pathname === "/api/0/projects/");
      expect(fallback?.searchParams.get("query")).toBe("dsn:shkey");
    });

    test("uses dsn-lookup when the server has it", async () => {
      const requestedUrls: string[] = [];
      globalThis.fetch = selfHostedServer(
        () =>
          jsonResponse({
            organizationSlug: "sentry",
            projectSlug: "internal",
            projectId: "3",
            projectName: "Internal",
          }),
        requestedUrls,
      );

      const project = await findProjectByDsn(SELF_HOSTED_DSN, "shkey");

      expect(project).toEqual({
        id: "3",
        slug: "internal",
        name: "Internal",
        organization: { id: "1", slug: "sentry", name: "Sentry" },
      });
      expect(
        requestedUrls.some((u) => new URL(u).pathname === "/api/0/projects/"),
      ).toBe(false);
    });

    test("doesn't fall back when dsn-lookup says the DSN isn't there", async () => {
      const requestedUrls: string[] = [];
      globalThis.fetch = selfHostedServer(
        () => jsonResponse(DSN_NOT_FOUND, 404),
        requestedUrls,
      );

      expect(await findProjectByDsn(SELF_HOSTED_DSN, "shkey")).toBeNull();
      expect(
        requestedUrls.some((u) => new URL(u).pathname === "/api/0/projects/"),
      ).toBe(false);
    });
  });
});

describe("org-scoped requests use region cache", () => {
  test("routes request to cached region URL", async () => {
    // Pre-populate region cache
    setOrgRegion("cached-org", "https://de.sentry.io");

    let capturedUrl: string | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      capturedUrl = req.url;

      return new Response(
        JSON.stringify({
          id: "600",
          slug: "cached-org",
          name: "Cached Organization",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    // Import getOrganization dynamically to use fresh module state
    const { getOrganization } = await import("../../src/lib/api-client.js");
    await getOrganization("cached-org");

    // Should route to EU region based on cache
    expect(capturedUrl).toContain("de.sentry.io");
    expect(capturedUrl).toContain("/organizations/cached-org/");
  });
});
