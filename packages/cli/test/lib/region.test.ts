/**
 * Region Resolution Tests
 *
 * Tests for resolving organization regions in multi-region Sentry support.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setAuthToken } from "../../src/lib/db/auth.js";
import { setOrgRegion } from "../../src/lib/db/regions.js";
import {
  isMultiRegionEnabled,
  resolveOrgRegion,
} from "../../src/lib/region.js";
import { getSentryBaseUrl } from "../../src/lib/sentry-urls.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("region-resolve-");

beforeEach(async () => {
  // Clear any SENTRY_HOST/SENTRY_URL override for most tests
  delete process.env.SENTRY_HOST;
  delete process.env.SENTRY_URL;
  // Set up auth token for API tests
  await setAuthToken("test-token");
});

afterEach(() => {
  delete process.env.SENTRY_HOST;
  delete process.env.SENTRY_URL;
});

describe("getSentryBaseUrl", () => {
  test("returns sentry.io by default", () => {
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
    expect(getSentryBaseUrl()).toBe("https://sentry.io");
  });

  test("respects SENTRY_URL env var", () => {
    process.env.SENTRY_URL = "https://sentry.mycompany.com";
    expect(getSentryBaseUrl()).toBe("https://sentry.mycompany.com");
  });

  test("respects SENTRY_HOST env var", () => {
    process.env.SENTRY_HOST = "https://sentry.mycompany.com";
    expect(getSentryBaseUrl()).toBe("https://sentry.mycompany.com");
  });

  test("SENTRY_HOST takes precedence over SENTRY_URL", () => {
    process.env.SENTRY_HOST = "https://host.example.com";
    process.env.SENTRY_URL = "https://url.example.com";
    expect(getSentryBaseUrl()).toBe("https://host.example.com");
  });
});

describe("isMultiRegionEnabled", () => {
  test("returns true for sentry.io (default)", () => {
    delete process.env.SENTRY_URL;
    expect(isMultiRegionEnabled()).toBe(true);
  });

  test("returns true for *.sentry.io URLs", () => {
    process.env.SENTRY_URL = "https://us.sentry.io";
    expect(isMultiRegionEnabled()).toBe(true);
  });

  test("returns true for de.sentry.io", () => {
    process.env.SENTRY_URL = "https://de.sentry.io";
    expect(isMultiRegionEnabled()).toBe(true);
  });

  test("returns false for self-hosted URLs", () => {
    process.env.SENTRY_URL = "https://sentry.mycompany.com";
    expect(isMultiRegionEnabled()).toBe(false);
  });

  test("returns false for localhost", () => {
    process.env.SENTRY_URL = "http://localhost:9000";
    expect(isMultiRegionEnabled()).toBe(false);
  });

  // Security edge cases - ensure proper URL parsing
  test("returns false for URL with sentry.io in path (not hostname)", () => {
    process.env.SENTRY_URL = "https://evil.com/sentry.io";
    expect(isMultiRegionEnabled()).toBe(false);
  });

  test("returns false for lookalike domain sentry.io.evil.com", () => {
    process.env.SENTRY_URL = "https://sentry.io.evil.com";
    expect(isMultiRegionEnabled()).toBe(false);
  });

  test("returns false for domain with sentry.io prefix", () => {
    process.env.SENTRY_URL = "https://sentry.io-fake.com";
    expect(isMultiRegionEnabled()).toBe(false);
  });

  test("returns false for invalid URL", () => {
    process.env.SENTRY_URL = "not-a-valid-url";
    expect(isMultiRegionEnabled()).toBe(false);
  });

  test("respects SENTRY_HOST for self-hosted", () => {
    process.env.SENTRY_HOST = "https://sentry.mycompany.com";
    expect(isMultiRegionEnabled()).toBe(false);
  });

  test("SENTRY_HOST takes precedence over SENTRY_URL", () => {
    process.env.SENTRY_HOST = "https://sentry.mycompany.com";
    process.env.SENTRY_URL = "https://us.sentry.io";
    expect(isMultiRegionEnabled()).toBe(false);
  });
});

describe("resolveOrgRegion", () => {
  test("returns cached region when available", async () => {
    setOrgRegion("cached-org", "https://de.sentry.io");

    const regionUrl = await resolveOrgRegion("cached-org");
    expect(regionUrl).toBe("https://de.sentry.io");
  });

  test("fetches and caches region from API on cache miss", async () => {
    // Import getOrgRegion to verify caching
    const { getOrgRegion } = await import("../../src/lib/db/regions.js");

    // Verify org is not in cache
    const before = getOrgRegion("new-org");
    expect(before).toBeUndefined();

    // Mock fetch to return org with regionUrl
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/organizations/new-org/")) {
        return new Response(
          JSON.stringify({
            id: "123",
            slug: "new-org",
            name: "New Organization",
            links: {
              organizationUrl: "https://de.sentry.io/organizations/new-org/",
              regionUrl: "https://de.sentry.io",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    try {
      const regionUrl = await resolveOrgRegion("new-org");

      // Should return the region from API
      expect(regionUrl).toBe("https://de.sentry.io");

      // Should have cached the region
      const after = getOrgRegion("new-org");
      expect(after).toBe("https://de.sentry.io");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses default URL as region when org has no links.regionUrl", async () => {
    // Mock fetch to return org without links
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/organizations/no-links-org/")) {
        return new Response(
          JSON.stringify({
            id: "456",
            slug: "no-links-org",
            name: "Org Without Links",
            // No links field
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    try {
      const regionUrl = await resolveOrgRegion("no-links-org");

      // Should fall back to default URL
      expect(regionUrl).toBe("https://sentry.io");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("resolves a relative regionUrl against baseUrl", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/organizations/relative-region-org/")) {
        return new Response(
          JSON.stringify({
            id: "789",
            slug: "relative-region-org",
            name: "Self-hosted Org",
            links: {
              organizationUrl: "/organizations/relative-region-org/",
              // Self-hosted instance returns a relative path instead of an absolute URL
              regionUrl: "/",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    try {
      const regionUrl = await resolveOrgRegion("relative-region-org");
      // Relative "/" resolves to the base origin, producing an absolute URL
      // instead of a broken relative value.
      expect(regionUrl).toBe("https://sentry.io");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to baseUrl when API returns a malformed regionUrl", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/organizations/malformed-region-org/")) {
        return new Response(
          JSON.stringify({
            id: "790",
            slug: "malformed-region-org",
            name: "Self-hosted Org 2",
            links: {
              organizationUrl: "/organizations/malformed-region-org/",
              regionUrl: "not-a-valid-url",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    try {
      // A path-like relative value resolves against the base origin.
      const regionUrl = await resolveOrgRegion("malformed-region-org");
      expect(regionUrl).toBe("https://sentry.io");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("falls back to default URL when API call fails", async () => {
    // Mock fetch to fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("Network error");
    };

    try {
      const regionUrl = await resolveOrgRegion("unknown-org");
      // Should fall back to default
      expect(regionUrl).toBe("https://sentry.io");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses SENTRY_URL as fallback for self-hosted", async () => {
    // The test's beforeEach stored an OAuth row with host = SaaS (since
    // SENTRY_URL was unset at store time). Re-scope the stored token to
    // the self-hosted host so the fetch-layer guard admits the request.
    process.env.SENTRY_URL = "https://sentry.mycompany.com";
    await setAuthToken("test-token", undefined, undefined, {
      host: "https://sentry.mycompany.com",
    });

    // Mock fetch to fail (no multi-region on self-hosted)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("Network error");
    };

    try {
      const regionUrl = await resolveOrgRegion("self-hosted-org");
      expect(regionUrl).toBe("https://sentry.mycompany.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses cached region on subsequent calls", async () => {
    // Pre-populate cache (simulating what happens after a successful API fetch)
    setOrgRegion("cached-org-2", "https://de.sentry.io");

    // First call should use cache
    const regionUrl1 = await resolveOrgRegion("cached-org-2");
    expect(regionUrl1).toBe("https://de.sentry.io");

    // Second call should also use cache
    const regionUrl2 = await resolveOrgRegion("cached-org-2");
    expect(regionUrl2).toBe("https://de.sentry.io");
  });

  test("cache survives across multiple resolve calls", async () => {
    // Populate cache with multiple orgs
    setOrgRegion("org-a", "https://us.sentry.io");
    setOrgRegion("org-b", "https://de.sentry.io");

    // Resolve in different order
    expect(await resolveOrgRegion("org-b")).toBe("https://de.sentry.io");
    expect(await resolveOrgRegion("org-a")).toBe("https://us.sentry.io");
    expect(await resolveOrgRegion("org-b")).toBe("https://de.sentry.io");
  });

  test("deduplicates concurrent API calls for the same org", async () => {
    let fetchCount = 0;

    // Mock fetch to track call count
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes("/organizations/dedup-org/")) {
        fetchCount += 1;
        // Small delay to ensure concurrency overlap
        await sleep(50);
        return new Response(
          JSON.stringify({
            id: "789",
            slug: "dedup-org",
            name: "Dedup Organization",
            links: {
              organizationUrl: "https://us.sentry.io/organizations/dedup-org/",
              regionUrl: "https://us.sentry.io",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
      return new Response(JSON.stringify({ detail: "Not found" }), {
        status: 404,
      });
    };

    try {
      // Fire 5 concurrent calls for the same org
      const results = await Promise.all([
        resolveOrgRegion("dedup-org"),
        resolveOrgRegion("dedup-org"),
        resolveOrgRegion("dedup-org"),
        resolveOrgRegion("dedup-org"),
        resolveOrgRegion("dedup-org"),
      ]);

      // All should return the same result
      for (const result of results) {
        expect(result).toBe("https://us.sentry.io");
      }

      // Only one fetch should have been made (in-flight dedup)
      expect(fetchCount).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
