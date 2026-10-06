/**
 * Tests for resolveEffectiveOrg and DSN org ID resolution.
 *
 * Covers the offline cache lookup path that resolves DSN-style org
 * identifiers (e.g., `o1081365`) to real org slugs using the local
 * org_regions cache.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setAuthToken } from "../../src/lib/db/auth.js";
import {
  getOrgByNumericId,
  getOrgRegion,
  setOrgRegion,
  setOrgRegions,
} from "../../src/lib/db/regions.js";
import { logger } from "../../src/lib/logger.js";
import { resolveEffectiveOrg } from "../../src/lib/region.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

useTestConfigDir("resolve-effective-org-");

// getOrgByNumericId (DB layer)

describe("getOrgByNumericId", () => {
  test("returns slug and regionUrl when org_id matches", async () => {
    setOrgRegions([
      { slug: "my-org", regionUrl: "https://us.sentry.io", orgId: "1081365" },
    ]);

    const result = getOrgByNumericId("1081365");
    expect(result).toEqual({
      slug: "my-org",
      regionUrl: "https://us.sentry.io",
    });
  });

  test("returns undefined when no org_id matches", async () => {
    setOrgRegions([
      { slug: "my-org", regionUrl: "https://us.sentry.io", orgId: "1081365" },
    ]);

    const result = getOrgByNumericId("9999999");
    expect(result).toBeUndefined();
  });

  test("returns undefined when org_id column is null", async () => {
    setOrgRegion("my-org", "https://us.sentry.io");

    const result = getOrgByNumericId("1081365");
    expect(result).toBeUndefined();
  });

  test("returns correct org when multiple orgs exist", async () => {
    setOrgRegions([
      { slug: "org-a", regionUrl: "https://us.sentry.io", orgId: "111" },
      { slug: "org-b", regionUrl: "https://de.sentry.io", orgId: "222" },
      { slug: "org-c", regionUrl: "https://us.sentry.io", orgId: "333" },
    ]);

    const result = getOrgByNumericId("222");
    expect(result).toEqual({
      slug: "org-b",
      regionUrl: "https://de.sentry.io",
    });
  });
});

// setOrgRegions with orgId

describe("setOrgRegions with orgId", () => {
  test("stores org_id and allows lookup by numeric ID", async () => {
    setOrgRegions([
      { slug: "acme", regionUrl: "https://us.sentry.io", orgId: "42" },
    ]);

    const region = getOrgRegion("acme");
    expect(region).toBe("https://us.sentry.io");

    const byId = getOrgByNumericId("42");
    expect(byId).toEqual({ slug: "acme", regionUrl: "https://us.sentry.io" });
  });

  test("handles entries without orgId", async () => {
    setOrgRegions([{ slug: "no-id-org", regionUrl: "https://de.sentry.io" }]);

    const region = getOrgRegion("no-id-org");
    expect(region).toBe("https://de.sentry.io");

    const byId = getOrgByNumericId("no-id-org");
    expect(byId).toBeUndefined();
  });

  test("upserts update region on slug conflict", async () => {
    setOrgRegions([
      { slug: "my-org", regionUrl: "https://us.sentry.io", orgId: "100" },
    ]);

    setOrgRegions([
      { slug: "my-org", regionUrl: "https://de.sentry.io", orgId: "100" },
    ]);

    const region = getOrgRegion("my-org");
    expect(region).toBe("https://de.sentry.io");

    const byId = getOrgByNumericId("100");
    expect(byId?.slug).toBe("my-org");
  });

  test("empty entries array is a no-op", async () => {
    setOrgRegions([]);
  });
});

// resolveEffectiveOrg — cache-hit paths (no API calls needed)

describe("resolveEffectiveOrg", () => {
  test("returns orgSlug when slug is already cached", async () => {
    setOrgRegion("my-org", "https://us.sentry.io");

    const result = await resolveEffectiveOrg("my-org");
    expect(result).toBe("my-org");
  });

  test("resolves DSN-style org via cached numeric ID", async () => {
    setOrgRegions([
      {
        slug: "acme-corp",
        regionUrl: "https://us.sentry.io",
        orgId: "1081365",
      },
    ]);

    const result = await resolveEffectiveOrg("o1081365");
    expect(result).toBe("acme-corp");
  });

  test("resolves another DSN org ID pattern", async () => {
    setOrgRegions([
      { slug: "test-org", regionUrl: "https://de.sentry.io", orgId: "42" },
    ]);

    const result = await resolveEffectiveOrg("o42");
    expect(result).toBe("test-org");
  });

  test("resolves large numeric ID", async () => {
    setOrgRegions([
      {
        slug: "big-org",
        regionUrl: "https://us.sentry.io",
        orgId: "9999999999",
      },
    ]);

    const result = await resolveEffectiveOrg("o9999999999");
    expect(result).toBe("big-org");
  });
});

// resolveEffectiveOrg — API refresh paths

describe("resolveEffectiveOrg with API refresh", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    await setAuthToken("test-token");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /**
   * Create a fetch mock that simulates the listOrganizations API chain.
   * Returns a single region + single org with the given slug and ID.
   */
  function mockListOrgsApi(orgSlug: string, orgId: string, regionUrl: string) {
    globalThis.fetch = mockFetch(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        const url = req.url;

        // /users/me/regions/ → return one region
        if (url.includes("/users/me/regions/")) {
          return new Response(
            JSON.stringify({
              regions: [{ name: "us", url: regionUrl }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        // /organizations/ → return the org
        if (url.includes("/organizations/")) {
          return new Response(
            JSON.stringify([
              {
                slug: orgSlug,
                id: orgId,
                name: orgSlug,
                links: {
                  organizationUrl: `${regionUrl}/organizations/${orgSlug}/`,
                  regionUrl,
                },
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response("Not found", { status: 404 });
      }
    );
  }

  test("resolves DSN org after API refresh when cache is cold", async () => {
    mockListOrgsApi("fresh-org", "5555", "https://us.sentry.io");

    const result = await resolveEffectiveOrg("o5555");
    expect(result).toBe("fresh-org");
  });

  test("resolves slug after API refresh populates cache", async () => {
    mockListOrgsApi("discovered-org", "777", "https://de.sentry.io");

    const result = await resolveEffectiveOrg("discovered-org");
    expect(result).toBe("discovered-org");
  });

  test("returns orgSlug when not found even after API refresh", async () => {
    mockListOrgsApi("other-org", "999", "https://us.sentry.io");

    const result = await resolveEffectiveOrg("nonexistent-org");
    expect(result).toBe("nonexistent-org");
  });

  test("returns orgSlug when not authenticated (no token)", async () => {
    // AuthError is thrown when there's no valid auth token.
    // Clear the token so refreshToken() throws AuthError.
    const { clearAuth } = await import("../../src/lib/db/auth.js");
    await clearAuth();

    // Set a silent fetch mock to prevent preload warnings.
    // Without auth, resolveEffectiveOrg tries an API refresh that fails,
    // then falls back to the original slug.
    globalThis.fetch = mockFetch(
      async () =>
        new Response(JSON.stringify({ detail: "Unauthorized" }), {
          status: 401,
        })
    );

    const result = await resolveEffectiveOrg("o1081365");
    expect(result).toBe("o1081365");
  });

  test("logs when resolveOrgRegion throws for a slug", async () => {
    const { clearAuth } = await import("../../src/lib/db/auth.js");
    await clearAuth();

    const savedAuthToken = process.env.SENTRY_AUTH_TOKEN;
    const savedSentryToken = process.env.SENTRY_TOKEN;
    delete process.env.SENTRY_AUTH_TOKEN;
    delete process.env.SENTRY_TOKEN;

    const debugSpy = vi.spyOn(logger, "debug");
    try {
      const result = await resolveEffectiveOrg("missing-org");
      expect(result).toBe("missing-org");
      expect(debugSpy).toHaveBeenCalledWith(
        "resolveOrgRegion failed for 'missing-org', using raw slug",
        expect.anything()
      );
    } finally {
      debugSpy.mockRestore();
      if (savedAuthToken === undefined) {
        delete process.env.SENTRY_AUTH_TOKEN;
      } else {
        process.env.SENTRY_AUTH_TOKEN = savedAuthToken;
      }
      if (savedSentryToken === undefined) {
        delete process.env.SENTRY_TOKEN;
      } else {
        process.env.SENTRY_TOKEN = savedSentryToken;
      }
    }
  });

  test("passes through non-DSN slugs starting with o", async () => {
    mockListOrgsApi("organic", "100", "https://us.sentry.io");

    const result = await resolveEffectiveOrg("organic");
    expect(result).toBe("organic");
  });

  test("passes through bare numeric IDs without o prefix", async () => {
    mockListOrgsApi("my-org", "1081365", "https://us.sentry.io");

    // "1081365" is not DSN-style (no "o" prefix) — won't match slug after refresh
    const result = await resolveEffectiveOrg("1081365");
    expect(result).toBe("1081365");
  });
});
