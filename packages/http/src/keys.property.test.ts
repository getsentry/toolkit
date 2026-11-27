/**
 * Property-based tests for cache key generation and URL normalization.
 */

import {
  array,
  asyncProperty,
  constantFrom,
  assert as fcAssert,
  property,
  string,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { buildCacheKey, normalizeUrl } from "./keys.js";

const DEFAULT_NUM_RUNS = 50;

/** Any non-empty identity; scoping across identities is in keys.test.ts. */
const IDENTITY = "test-identity";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate valid HTTP methods */
const methodArb = constantFrom("GET", "POST", "PUT", "DELETE", "PATCH");

/** Generate simple path segments */
const pathSegmentArb = string({ minLength: 1, maxLength: 20 }).filter((s) =>
  /^[a-zA-Z0-9_-]+$/.test(s),
);

/** Generate URL-like strings with paths and query params */
const sentryUrlArb = tuple(
  constantFrom(
    "https://us.sentry.io",
    "https://de.sentry.io",
    "https://sentry.io",
  ),
  array(pathSegmentArb, { minLength: 1, maxLength: 5 }),
  array(
    tuple(
      string({ minLength: 1, maxLength: 10 }).filter((s) =>
        /^[a-zA-Z]+$/.test(s),
      ),
      string({ minLength: 1, maxLength: 20 }).filter((s) =>
        /^[a-zA-Z0-9]+$/.test(s),
      ),
    ),
    { minLength: 0, maxLength: 4 },
  ),
).map(([base, paths, params]) => {
  const pathStr = `/api/0/${paths.join("/")}`;
  const query =
    params.length > 0
      ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}`
      : "";
  return `${base}${pathStr}${query}`;
});

// ---------------------------------------------------------------------------
// Tests: buildCacheKey
// ---------------------------------------------------------------------------

describe("property: buildCacheKey", () => {
  test("produces a 64-char hex string (SHA-256)", async () => {
    await fcAssert(
      asyncProperty(methodArb, sentryUrlArb, async (method, url) => {
        expect(await buildCacheKey(method, url, IDENTITY)).toMatch(
          /^[0-9a-f]{64}$/,
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("is deterministic — same inputs produce same key", async () => {
    await fcAssert(
      asyncProperty(methodArb, sentryUrlArb, async (method, url) => {
        expect(await buildCacheKey(method, url, IDENTITY)).toBe(
          await buildCacheKey(method, url, IDENTITY),
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("different methods produce different keys for same URL", async () => {
    await fcAssert(
      asyncProperty(sentryUrlArb, async (url) => {
        expect(await buildCacheKey("GET", url, IDENTITY)).not.toBe(
          await buildCacheKey("POST", url, IDENTITY),
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("query param order does not affect the key", async () => {
    await fcAssert(
      asyncProperty(
        constantFrom("https://us.sentry.io", "https://de.sentry.io"),
        pathSegmentArb,
        async (base, path) => {
          const url1 = `${base}/api/0/${path}?a=1&b=2&c=3`;
          const url2 = `${base}/api/0/${path}?c=3&a=1&b=2`;
          expect(await buildCacheKey("GET", url1, IDENTITY)).toBe(
            await buildCacheKey("GET", url2, IDENTITY),
          );
        },
      ),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("method comparison is case-insensitive", async () => {
    await fcAssert(
      asyncProperty(sentryUrlArb, async (url) => {
        expect(await buildCacheKey("get", url, IDENTITY)).toBe(
          await buildCacheKey("GET", url, IDENTITY),
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: normalizeUrl
// ---------------------------------------------------------------------------

describe("property: normalizeUrl", () => {
  test("sorts query parameters alphabetically", () => {
    const normalized = normalizeUrl("GET", "https://sentry.io/api?z=1&a=2&m=3");
    expect(normalized).toBe("GET|https://sentry.io/api?a=2&m=3&z=1");
  });

  test("uppercases the method", () => {
    fcAssert(
      property(
        constantFrom("get", "post", "put", "delete"),
        sentryUrlArb,
        (method, url) => {
          const normalized = normalizeUrl(method, url);
          expect(normalized.startsWith(method.toUpperCase())).toBe(true);
        },
      ),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("produces pipe-separated method|url format", () => {
    fcAssert(
      property(methodArb, sentryUrlArb, (method, url) => {
        const normalized = normalizeUrl(method, url);
        expect(normalized).toContain("|");
        const [m] = normalized.split("|", 1);
        expect(m).toBe(method.toUpperCase());
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });
});
