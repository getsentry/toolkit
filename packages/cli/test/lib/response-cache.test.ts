/**
 * Unit Tests for Response Cache
 *
 * Tests the cache lifecycle: store, retrieve, expire, clear, and bypass.
 * Uses isolated temp directories per test to avoid interference.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setAuthToken } from "../../src/lib/db/auth.js";
import {
  buildCacheKey,
  clearResponseCache,
  disableResponseCache,
  getCachedResponse,
  invalidateCachedResponsesMatching,
  normalizeUrl,
  resetCacheState,
  storeCachedResponse,
} from "../../src/lib/response-cache.js";
import { useTestConfigDir } from "../helpers.js";

const getConfigDir = useTestConfigDir("response-cache-");

// Reset cache disabled state between tests
let savedNoCache: string | undefined;

beforeEach(() => {
  savedNoCache = process.env.SENTRY_NO_CACHE;
  delete process.env.SENTRY_NO_CACHE;
  resetCacheState();
});

afterEach(() => {
  if (savedNoCache !== undefined) {
    process.env.SENTRY_NO_CACHE = savedNoCache;
  } else {
    delete process.env.SENTRY_NO_CACHE;
  }
  resetCacheState();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock Response with JSON body and optional headers */
function mockResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

const TEST_URL = "https://us.sentry.io/api/0/organizations/myorg/projects/";
const TEST_METHOD = "GET";
const TEST_BODY = { data: [{ id: 1, name: "test" }] };

// ---------------------------------------------------------------------------
// Store and Retrieve
// ---------------------------------------------------------------------------

describe("store and retrieve", () => {
  test("round-trip: store then retrieve returns same body", async () => {
    const response = mockResponse(TEST_BODY);
    await storeCachedResponse(TEST_METHOD, TEST_URL, {}, response);

    const cached = await getCachedResponse(TEST_METHOD, TEST_URL, {});
    expect(cached).toBeDefined();
    expect(cached!.status).toBe(200);

    const cachedBody = await cached!.json();
    expect(cachedBody).toEqual(TEST_BODY);
  });

  test("preserves Link header for pagination", async () => {
    const linkHeader =
      '<https://us.sentry.io/api/0/.../?cursor=123:0:0>; rel="next"';
    const response = mockResponse(TEST_BODY, 200, { link: linkHeader });
    await storeCachedResponse(TEST_METHOD, TEST_URL, {}, response);

    const cached = await getCachedResponse(TEST_METHOD, TEST_URL, {});
    expect(cached).toBeDefined();
    expect(cached!.headers.get("link")).toBe(linkHeader);
  });

  test("cache miss returns undefined", async () => {
    const cached = await getCachedResponse(
      TEST_METHOD,
      "https://us.sentry.io/api/0/organizations/nonexistent/projects/",
      {}
    );
    expect(cached).toBeUndefined();
  });

  test("different URLs produce different cache entries", async () => {
    const url1 = "https://us.sentry.io/api/0/organizations/org1/projects/";
    const url2 = "https://us.sentry.io/api/0/organizations/org2/projects/";
    const body1 = { data: "org1" };
    const body2 = { data: "org2" };

    await storeCachedResponse(TEST_METHOD, url1, {}, mockResponse(body1));
    await storeCachedResponse(TEST_METHOD, url2, {}, mockResponse(body2));

    const cached1 = await getCachedResponse(TEST_METHOD, url1, {});
    const cached2 = await getCachedResponse(TEST_METHOD, url2, {});

    expect(await cached1!.json()).toEqual(body1);
    expect(await cached2!.json()).toEqual(body2);
  });

  test("query param order does not affect cache lookup", async () => {
    const url1 = "https://us.sentry.io/api/0/orgs/?a=1&b=2";
    const url2 = "https://us.sentry.io/api/0/orgs/?b=2&a=1";

    await storeCachedResponse(TEST_METHOD, url1, {}, mockResponse(TEST_BODY));

    const cached = await getCachedResponse(TEST_METHOD, url2, {});
    expect(cached).toBeDefined();
    expect(await cached!.json()).toEqual(TEST_BODY);
  });
});

// ---------------------------------------------------------------------------
// Method isolation
// ---------------------------------------------------------------------------

describe("method isolation", () => {
  test("only GET requests are cached", async () => {
    await storeCachedResponse("POST", TEST_URL, {}, mockResponse(TEST_BODY));

    const cached = await getCachedResponse("POST", TEST_URL, {});
    expect(cached).toBeUndefined();
  });

  test("GET lookup does not return POST-stored data", async () => {
    // This is already guaranteed since POST doesn't store, but test explicitly
    await storeCachedResponse("GET", TEST_URL, {}, mockResponse(TEST_BODY));

    // GET should find it
    const getResult = await getCachedResponse("GET", TEST_URL, {});
    expect(getResult).toBeDefined();

    // POST should not even look
    const postResult = await getCachedResponse("POST", TEST_URL, {});
    expect(postResult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-2xx responses
// ---------------------------------------------------------------------------

describe("non-2xx responses", () => {
  test("4xx responses are not cached", async () => {
    await storeCachedResponse(
      TEST_METHOD,
      TEST_URL,
      {},
      mockResponse({ detail: "not found" }, 404)
    );

    const cached = await getCachedResponse(TEST_METHOD, TEST_URL, {});
    expect(cached).toBeUndefined();
  });

  test("5xx responses are not cached", async () => {
    await storeCachedResponse(
      TEST_METHOD,
      TEST_URL,
      {},
      mockResponse({ detail: "server error" }, 500)
    );

    const cached = await getCachedResponse(TEST_METHOD, TEST_URL, {});
    expect(cached).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cache-Control: no-store
// ---------------------------------------------------------------------------

describe("Cache-Control: no-store", () => {
  test("responses with no-store are not cached", async () => {
    const response = mockResponse(TEST_BODY, 200, {
      "cache-control": "no-store",
    });
    await storeCachedResponse(TEST_METHOD, TEST_URL, {}, response);

    const cached = await getCachedResponse(TEST_METHOD, TEST_URL, {});
    expect(cached).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clearResponseCache
// ---------------------------------------------------------------------------

describe("clearResponseCache", () => {
  test("removes all cached entries", async () => {
    const url1 = "https://us.sentry.io/api/0/orgs/a/projects/";
    const url2 = "https://us.sentry.io/api/0/orgs/b/projects/";

    await storeCachedResponse(TEST_METHOD, url1, {}, mockResponse({ a: 1 }));
    await storeCachedResponse(TEST_METHOD, url2, {}, mockResponse({ b: 2 }));

    // Verify entries exist
    expect(await getCachedResponse(TEST_METHOD, url1, {})).toBeDefined();

    await clearResponseCache();

    // Verify all cleared
    expect(await getCachedResponse(TEST_METHOD, url1, {})).toBeUndefined();
    expect(await getCachedResponse(TEST_METHOD, url2, {})).toBeUndefined();
  });

  test("is idempotent — clearing empty cache does not throw", async () => {
    await clearResponseCache();
    await clearResponseCache();
    // No error
  });
});

// ---------------------------------------------------------------------------
// Cache bypass
// ---------------------------------------------------------------------------

describe("cache bypass", () => {
  test("SENTRY_NO_CACHE=1 bypasses cache reads", async () => {
    await storeCachedResponse(
      TEST_METHOD,
      TEST_URL,
      {},
      mockResponse(TEST_BODY)
    );

    process.env.SENTRY_NO_CACHE = "1";

    const cached = await getCachedResponse(TEST_METHOD, TEST_URL, {});
    expect(cached).toBeUndefined();
  });

  test("SENTRY_NO_CACHE=1 bypasses cache writes", async () => {
    process.env.SENTRY_NO_CACHE = "1";

    await storeCachedResponse(
      TEST_METHOD,
      TEST_URL,
      {},
      mockResponse(TEST_BODY)
    );

    // Remove the bypass to verify nothing was written
    delete process.env.SENTRY_NO_CACHE;

    const cached = await getCachedResponse(TEST_METHOD, TEST_URL, {});
    expect(cached).toBeUndefined();
  });

  test("--fresh bypasses cache reads", async () => {
    await storeCachedResponse(
      TEST_METHOD,
      TEST_URL,
      {},
      mockResponse(TEST_BODY)
    );

    disableResponseCache();

    const cached = await getCachedResponse(TEST_METHOD, TEST_URL, {});
    expect(cached).toBeUndefined();
  });

  test("--fresh still allows cache writes", async () => {
    disableResponseCache();

    const freshBody = { data: "fresh" };
    await storeCachedResponse(
      TEST_METHOD,
      TEST_URL,
      {},
      mockResponse(freshBody)
    );

    // Re-enable cache reads to verify the write succeeded
    resetCacheState();

    const cached = await getCachedResponse(TEST_METHOD, TEST_URL, {});
    expect(cached).toBeDefined();
    expect(await cached!.json()).toEqual(freshBody);
  });

  test("--fresh round-trip: stale entry is replaced by fresh response", async () => {
    const staleBody = { data: "stale" };
    const freshBody = { data: "fresh" };

    // Store initial stale entry
    await storeCachedResponse(
      TEST_METHOD,
      TEST_URL,
      {},
      mockResponse(staleBody)
    );

    // Activate --fresh: reads are bypassed, but writes still go through
    disableResponseCache();

    // Verify stale entry is not served
    const duringFresh = await getCachedResponse(TEST_METHOD, TEST_URL, {});
    expect(duringFresh).toBeUndefined();

    // Store fresh response (overwrites the stale entry)
    await storeCachedResponse(
      TEST_METHOD,
      TEST_URL,
      {},
      mockResponse(freshBody)
    );

    // Re-enable cache reads (simulates next invocation without --fresh)
    resetCacheState();

    // Verify fresh data is served from cache
    const afterFresh = await getCachedResponse(TEST_METHOD, TEST_URL, {});
    expect(afterFresh).toBeDefined();
    expect(await afterFresh!.json()).toEqual(freshBody);
  });
});

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------

describe("normalizeUrl", () => {
  test("sorts query params alphabetically", () => {
    const result = normalizeUrl(
      "GET",
      "https://sentry.io/api/0/issues/?b=2&a=1"
    );
    expect(result).toBe("GET|https://sentry.io/api/0/issues/?a=1&b=2");
  });

  test("uppercases the method", () => {
    const result = normalizeUrl("get", "https://sentry.io/api/0/issues/");
    expect(result).toMatch(/^GET\|/);
  });

  test("throws on invalid URLs", () => {
    expect(() => normalizeUrl("GET", "not-a-valid-url")).toThrow();
  });

  test("handles self-hosted URLs with unusual schemes", () => {
    const result = normalizeUrl(
      "GET",
      "https://sentry.mycompany.internal/api/0/issues/"
    );
    expect(result).toBe("GET|https://sentry.mycompany.internal/api/0/issues/");
  });
});

// ---------------------------------------------------------------------------
// buildCacheKey
// ---------------------------------------------------------------------------

describe("buildCacheKey", () => {
  test("produces a 64-char hex string", () => {
    expect(buildCacheKey("GET", TEST_URL)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is deterministic", () => {
    expect(buildCacheKey("GET", TEST_URL)).toBe(buildCacheKey("GET", TEST_URL));
  });

  test("different methods produce different keys", () => {
    expect(buildCacheKey("GET", TEST_URL)).not.toBe(
      buildCacheKey("POST", TEST_URL)
    );
  });

  test("different identities produce different keys for the same URL", () => {
    // Switching accounts must route reads/writes through a different
    // namespace so users never see each other's cached data.
    setAuthToken("alice_access", 3600, "alice_refresh");
    const aliceKey = buildCacheKey("GET", TEST_URL);
    setAuthToken("bob_access", 3600, "bob_refresh");
    const bobKey = buildCacheKey("GET", TEST_URL);
    expect(aliceKey).not.toBe(bobKey);
  });
});

// ---------------------------------------------------------------------------
// Invalid URL handling (CLI-GC)
// ---------------------------------------------------------------------------

describe("invalid URL handling", () => {
  test("getCachedResponse skips cache for malformed URLs", async () => {
    const result = await getCachedResponse("GET", "not-a-valid-url", {});
    expect(result).toBeUndefined();
  });

  test("storeCachedResponse skips cache for malformed URLs", async () => {
    // Should not throw — just silently skip
    await storeCachedResponse(
      "GET",
      "not-a-valid-url",
      {},
      mockResponse({ ok: true })
    );
  });
});

// ---------------------------------------------------------------------------
// No-cache tier (polling endpoints)
// ---------------------------------------------------------------------------

describe("no-cache tier", () => {
  test("autofix URLs are not cached", async () => {
    const autofixUrl =
      "https://us.sentry.io/api/0/organizations/myorg/issues/123/autofix/";
    await storeCachedResponse(
      TEST_METHOD,
      autofixUrl,
      {},
      mockResponse({ autofix: { status: "PROCESSING" } })
    );

    const cached = await getCachedResponse(TEST_METHOD, autofixUrl, {});
    expect(cached).toBeUndefined();
  });

  test("root-cause URLs are not cached", async () => {
    const rootCauseUrl =
      "https://us.sentry.io/api/0/organizations/myorg/issues/123/root-cause/";
    await storeCachedResponse(
      TEST_METHOD,
      rootCauseUrl,
      {},
      mockResponse({ cause: "something" })
    );

    const cached = await getCachedResponse(TEST_METHOD, rootCauseUrl, {});
    expect(cached).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// File structure
// ---------------------------------------------------------------------------

describe("file structure", () => {
  test("creates cache directory under config dir", async () => {
    await storeCachedResponse(
      TEST_METHOD,
      TEST_URL,
      {},
      mockResponse(TEST_BODY)
    );

    const cacheDir = join(getConfigDir(), "cache", "responses");
    const files = await readdir(cacheDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  test("atomic write leaves no temp file behind on success", async () => {
    await storeCachedResponse(
      TEST_METHOD,
      TEST_URL,
      {},
      mockResponse(TEST_BODY)
    );

    const cacheDir = join(getConfigDir(), "cache", "responses");
    const files = await readdir(cacheDir);
    // Exactly the final .json file — the temp file was renamed into place.
    expect(files.every((f) => f.endsWith(".json"))).toBe(true);
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Atomic write / torn-read regression (getsentry/cli#1056)
//
// A write fires cleanupCache() fire-and-forget at 10% probability. Before
// atomic writes, a second write to the same key could be read mid-overwrite by
// that cleanup sweep, fail to JSON.parse, and be deleted as "corrupted" —
// losing a valid entry. This loop exercises the exact store→overwrite→read
// sequence many times so the probabilistic cleanup is virtually guaranteed to
// fire; every iteration must still serve the fresh value.
// ---------------------------------------------------------------------------

describe("atomic write regression", () => {
  test("repeated overwrite-then-read never loses the entry", async () => {
    for (let i = 0; i < 50; i++) {
      await storeCachedResponse(
        TEST_METHOD,
        TEST_URL,
        {},
        mockResponse({ data: `stale-${i}` })
      );
      const freshBody = { data: `fresh-${i}` };
      await storeCachedResponse(
        TEST_METHOD,
        TEST_URL,
        {},
        mockResponse(freshBody)
      );

      const cached = await getCachedResponse(TEST_METHOD, TEST_URL, {});
      expect(cached).toBeDefined();
      expect(await cached!.json()).toEqual(freshBody);
    }
  });
});

// ---------------------------------------------------------------------------
// Prefix-based invalidation + identity isolation (getsentry/cli#788 follow-up)
// ---------------------------------------------------------------------------

describe("invalidateCachedResponsesMatching", () => {
  const ORG_PREFIX = "https://us.sentry.io/api/0/organizations/myorg/projects/";
  const ORG_LIST_URL = `${ORG_PREFIX}?cursor=abc`;
  const OTHER_PREFIX =
    "https://us.sentry.io/api/0/organizations/other-org/projects/";

  test("removes entries whose URL matches the prefix", async () => {
    await storeCachedResponse(
      "GET",
      ORG_LIST_URL,
      {},
      mockResponse({ matched: true })
    );
    await storeCachedResponse(
      "GET",
      `${OTHER_PREFIX}?cursor=def`,
      {},
      mockResponse({ matched: false })
    );

    await invalidateCachedResponsesMatching(ORG_PREFIX);

    // The matching entry is gone; the other org's entry survives.
    expect(await getCachedResponse("GET", ORG_LIST_URL, {})).toBeUndefined();
    const survivor = await getCachedResponse(
      "GET",
      `${OTHER_PREFIX}?cursor=def`,
      {}
    );
    expect(survivor).toBeDefined();
  });

  test("does not delete entries belonging to a different identity", async () => {
    // A writes a cache entry, B sweeps the same URL prefix; A's entry
    // must survive because B can only see its own identity's files.
    setAuthToken("identity-a", 3600, "refresh-a");
    await storeCachedResponse(
      "GET",
      ORG_LIST_URL,
      {},
      mockResponse({ owner: "a" })
    );
    expect(await getCachedResponse("GET", ORG_LIST_URL, {})).toBeDefined();

    setAuthToken("identity-b", 3600, "refresh-b");
    await invalidateCachedResponsesMatching(ORG_PREFIX);

    setAuthToken("identity-a", 3600, "refresh-a");
    expect(await getCachedResponse("GET", ORG_LIST_URL, {})).toBeDefined();
  });

  test("is a no-op when the cache dir does not exist", async () => {
    await invalidateCachedResponsesMatching(ORG_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// Regression: prefix-sweep must catch query-string variants
// (sentry-bot finding on #788 — `getIssue` caches under
// `/issues/{id}/?collapse=stats&...` so exact-match invalidation of
// `/issues/{id}/` would silently fail to clear the stale entry.)
// ---------------------------------------------------------------------------

describe("invalidateCachedResponsesMatching with query params", () => {
  const DETAIL_BASE =
    "https://us.sentry.io/api/0/organizations/acme/issues/12345/";

  test("clears entries cached with varying query parameters", async () => {
    await storeCachedResponse(
      "GET",
      `${DETAIL_BASE}?collapse=stats&collapse=lifetime`,
      {},
      mockResponse({ id: "12345" })
    );
    expect(
      await getCachedResponse(
        "GET",
        `${DETAIL_BASE}?collapse=stats&collapse=lifetime`,
        {}
      )
    ).toBeDefined();

    // Mutation-side invalidator uses the base URL (no params).
    await invalidateCachedResponsesMatching(DETAIL_BASE);

    expect(
      await getCachedResponse(
        "GET",
        `${DETAIL_BASE}?collapse=stats&collapse=lifetime`,
        {}
      )
    ).toBeUndefined();
  });
});
