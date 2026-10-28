/**
 * HTTP response cache for read-only API calls.
 *
 * Uses `http-cache-semantics` (RFC 7234/9111) to make correct caching decisions.
 * When the server provides `Cache-Control` / `ETag` / `Expires` headers, they
 * are respected automatically. When the server sends no cache headers (Sentry's
 * current behavior), a URL-based fallback TTL is applied.
 *
 * Bodies are compressed with the toolkit-core codec and kept in a
 * filesystem store under `~/.sentry/cache/responses/` (see
 * `response-cache-store.ts`), separate from the config SQLite database, which
 * stores small structured data (tokens, org slugs, cursors).
 *
 * @module
 */

import { join } from "node:path";
import {
  buildCacheKey as buildIdentityCacheKey,
  type CacheEntry,
  classifyUrl,
  FALLBACK_TTL_MS,
} from "@sentry/toolkit-core/response-cache";
import { createBodyCodec } from "@sentry/toolkit-core/response-cache/codec";
import CachePolicy from "http-cache-semantics";

import { getIdentityFingerprint } from "./db/auth.js";
import { getConfigDir } from "./db/index.js";
import { getEnv } from "./env.js";
import { logger } from "./logger.js";
import { createFileStore, type FileStore } from "./response-cache-store.js";
import { recordCacheHit, withCacheSpan } from "./telemetry.js";

/** Tagged logger for diagnostic visibility into best-effort cache operations. */
const log = logger.withTag("response-cache");

// ---------------------------------------------------------------------------
// Cache keys — tiers, keys, and invalidation prefixes live in toolkit-core
// ---------------------------------------------------------------------------

/**
 * Build the cache key for the active identity + method + URL.
 *
 * @internal Exported for testing
 */
export async function buildCacheKey(
  method: string,
  url: string,
  identity = getIdentityFingerprint(),
): Promise<string> {
  return await buildIdentityCacheKey(method, url, identity);
}

// ---------------------------------------------------------------------------
// Cache constants
// ---------------------------------------------------------------------------

/** CachePolicy options for a single-user CLI cache */
const POLICY_OPTIONS: CachePolicy.Options = {
  shared: false,
  cacheHeuristic: 0.1,
};

/**
 * Headers that should be preserved in the cache for consumers.
 * Only includes headers that affect API client behavior (e.g., pagination).
 */
const PRESERVED_HEADERS = ["link"];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Get the response cache directory path */
function getCacheDir(): string {
  return join(getConfigDir(), "cache", "responses");
}

const codec = createBodyCodec();
const encoder = new TextEncoder();

let current: { dir: string; store: FileStore } | undefined;

/**
 * The store for the current config dir. Call it before any `await`, so a
 * fire-and-forget write finishes in the directory its request started in.
 */
function getStore(): FileStore {
  const dir = getCacheDir();
  if (current?.dir !== dir) {
    current = { dir, store: createFileStore({ dir }) };
  }
  return current.store;
}

/** Extract the subset of response headers worth caching */
function pickHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of PRESERVED_HEADERS) {
    const value = headers.get(name);
    if (value) {
      result[name] = value;
    }
  }
  return result;
}

/** Convert Headers to a plain object for http-cache-semantics */
function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

/**
 * Check whether the server sent explicit cache-control directives.
 *
 * When `rescc` (response cache-control) is empty, the server sent no
 * Cache-Control header. When it has keys, the server explicitly provided
 * directives (e.g., `max-age=0`, `no-cache`, `max-age=300`).
 *
 * This distinction is critical: `timeToLive() === 0` is ambiguous — it can
 * mean "no headers" (use fallback TTL) or "max-age=0" (don't cache).
 */
function hasServerCacheDirectives(policy: CachePolicy): boolean {
  const { rescc } = policy.toObject();
  return Object.keys(rescc).length > 0;
}

/**
 * Check whether a cache entry is still fresh.
 *
 * Uses the server-provided TTL (via CachePolicy) when available. Falls back
 * to URL-based TTL tiers when the server sends no cache headers.
 */
function isEntryFresh(
  policy: CachePolicy,
  entry: CacheEntry,
  requestHeaders: Record<string, string>,
  url: string,
): boolean {
  const newRequest = { url, method: "GET", headers: requestHeaders };
  if (policy.satisfiesWithoutRevalidation(newRequest)) {
    return true;
  }

  // If the server sent explicit cache directives (e.g., max-age=0), respect
  // them — CachePolicy already said stale, so this entry is expired.
  if (hasServerCacheDirectives(policy)) {
    return false;
  }

  // No server cache headers — use our URL-based fallback tier
  const tier = classifyUrl(url);
  const fallbackTtl = FALLBACK_TTL_MS[tier];
  const age = Date.now() - entry.createdAt;
  return age <= fallbackTtl;
}

/**
 * Build the response headers for a cached entry.
 * Merges CachePolicy's computed headers with our preserved headers.
 * Flattens multi-value headers into comma-separated strings for the Response API.
 */
function buildResponseHeaders(
  policy: CachePolicy,
  entry: CacheEntry,
): Record<string, string> {
  const policyHeaders = policy.responseHeaders();
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(policyHeaders)) {
    if (value === undefined) {
      continue;
    }
    result[name] = Array.isArray(value) ? value.join(", ") : value;
  }

  // Merge preserved headers (like Link for pagination)
  for (const [name, value] of Object.entries(entry.headers)) {
    if (!(name in result)) {
      result[name] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Last cache-hit age — process-global signal for cache-age hints
// ---------------------------------------------------------------------------

/**
 * Age of the most recent cache hit, in milliseconds.
 *
 * Set inside {@link getCachedResponse} on a hit, cleared at the start of each
 * `authenticatedFetch` call in `sentry-client.ts`. Commands read it via
 * {@link getLastCacheHitAge} to show "cached · 3m ago · use -f to refresh".
 *
 * Safe because the CLI is single-process, single-command — no races.
 */
let lastCacheHitAgeMs: number | undefined;

/**
 * Get the age (in ms) of the most recent cache hit, or `undefined` if the
 * last request was not served from cache.
 */
export function getLastCacheHitAge(): number | undefined {
  return lastCacheHitAgeMs;
}

/**
 * Clear the last cache-hit age. Called at the top of each `authenticatedFetch`
 * call so the signal reflects only the current request.
 */
export function clearLastCacheHitAge(): void {
  lastCacheHitAgeMs = undefined;
}

/**
 * Set the last cache-hit age directly. Test-only — production code paths
 * set this implicitly via {@link getCachedResponse} on a real cache hit.
 *
 * @internal Exported for testing
 */
export function setLastCacheHitAgeForTesting(ageMs: number): void {
  lastCacheHitAgeMs = ageMs;
}

// ---------------------------------------------------------------------------
// Cache bypass control
// ---------------------------------------------------------------------------

let cacheReadBypassed = false;

/**
 * Bypass cache reads for the current process.
 *
 * Called when `--fresh` flag is passed to a command. Fresh API responses are
 * still written to cache so subsequent invocations serve updated data.
 */
export function disableResponseCache(): void {
  cacheReadBypassed = true;
}

/**
 * Re-enable cache reads after `disableResponseCache()` was called.
 *
 * This is only needed in tests to prevent one test's `--fresh` flag from
 * permanently disabling caching for subsequent tests in the same process.
 * Production CLI invocations are single-process, so the flag resets naturally.
 *
 * @internal Exported for testing
 */
export function resetCacheState(): void {
  cacheReadBypassed = false;
}

/**
 * Check if cache reads are disabled.
 * Reads are skipped when:
 * - `disableResponseCache()` was called (`--fresh` flag)
 * - `SENTRY_NO_CACHE=1` environment variable is set
 */
export function isCacheDisabled(): boolean {
  return cacheReadBypassed || getEnv().SENTRY_NO_CACHE === "1";
}

/**
 * Check if cache writes are disabled.
 *
 * Only the `SENTRY_NO_CACHE=1` env var disables writes. The `--fresh` flag
 * intentionally allows writes so that the freshly-fetched response replaces
 * any stale cache entry.
 */
function isCacheWriteDisabled(): boolean {
  return getEnv().SENTRY_NO_CACHE === "1";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempt to serve a cached response for a GET request.
 *
 * Reconstructs the `CachePolicy` from the stored entry and verifies the
 * cached response still satisfies the new request.
 *
 * @param method - HTTP method (only "GET" is cached)
 * @param url - Full request URL
 * @param requestHeaders - Headers from the new request
 * @returns A synthetic Response if cache hit, or undefined on miss/expired
 */
export async function getCachedResponse(
  method: string,
  url: string,
  requestHeaders: Record<string, string>,
  identity = getIdentityFingerprint(),
): Promise<Response | undefined> {
  if (
    method !== "GET" ||
    isCacheDisabled() ||
    classifyUrl(url) === "no-cache"
  ) {
    return;
  }

  const store = getStore();
  let key: string;
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    key = await buildCacheKey(method, url, identity);
  } catch {
    // Malformed URL or empty identity — skip cache lookup. The request
    // itself will surface any real URL error.
    return;
  }

  return await withCacheSpan(
    url,
    "cache.get",
    async (span) => {
      const miss = (): undefined => {
        span.setAttribute("cache.hit", false);
        recordCacheHit("http", false);
        return;
      };

      const entry = await store.get(key);
      if (!entry) {
        return miss();
      }

      try {
        const policy = CachePolicy.fromObject(
          entry.policy as CachePolicy.CachePolicyObject,
        );
        if (!isEntryFresh(policy, entry, requestHeaders, url)) {
          return miss();
        }

        // `undefined` when this runtime cannot read the encoding, such as a
        // zstd entry after a downgrade to Node < 22.15.
        const body = await codec.decode(entry.body);
        if (!body) {
          return miss();
        }

        span.setAttribute("cache.hit", true);
        recordCacheHit("http", true);
        span.setAttribute("cache.item_size", body.byteLength);

        // Surface cache age for command-level hints (getsentry/cli#785 #1)
        lastCacheHitAgeMs = Date.now() - entry.createdAt;

        return new Response(body, {
          status: entry.status,
          headers: buildResponseHeaders(policy, entry),
        });
      } catch (error) {
        // Corrupted or version-incompatible policy or body — treat as a miss
        // and drop the broken entry.
        log.debug("Dropping unreadable cache entry", error);
        await store.delete(key);
        return miss();
      }
    },
    {
      "cache.key": [key],
      "network.peer.address": getCacheDir(),
    },
  );
}

/**
 * Store a response in the cache.
 *
 * Only caches successful (2xx) GET responses. Uses `http-cache-semantics` to
 * determine if the response is storable per RFC 7234. If the server explicitly
 * sends `Cache-Control: no-store`, the response is not cached.
 *
 * This function is fire-and-forget — errors are silently swallowed to avoid
 * slowing down the response path.
 *
 * @param method - HTTP method
 * @param url - Full request URL
 * @param requestHeaders - Request headers
 * @param response - The fetch Response to cache (must be cloned before passing)
 */
export async function storeCachedResponse(
  method: string,
  url: string,
  requestHeaders: Record<string, string>,
  response: Response,
  identity = getIdentityFingerprint(),
): Promise<void> {
  if (
    method !== "GET" ||
    isCacheWriteDisabled() ||
    !response.ok ||
    classifyUrl(url) === "no-cache"
  ) {
    return;
  }

  const store = getStore();
  let key: string;
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    key = await buildCacheKey(method, url, identity);
  } catch {
    // Malformed URL or empty identity — skip caching this response
    return;
  }

  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    await withCacheSpan(
      url,
      "cache.put",
      async (span) => {
        const size = await writeResponseToCache({
          store,
          key,
          identity,
          url,
          requestHeaders,
          response,
        });
        if (size > 0) {
          span.setAttribute("cache.item_size", size);
        }
      },
      {
        "cache.key": [key],
        "network.peer.address": getCacheDir(),
      },
    );
  } catch {
    // Cache write failures are non-fatal — silently ignore
  }
}

/** Inputs for {@link writeResponseToCache}, bundled to stay under useMaxParams. */
type WriteRequest = {
  store: FileStore;
  key: string;
  identity: string;
  url: string;
  requestHeaders: Record<string, string>;
  response: Response;
};

/**
 * Core cache write logic. Always called for GET requests.
 *
 * @returns Stored (compressed) body size in bytes (0 if not storable).
 */
async function writeResponseToCache(req: WriteRequest): Promise<number> {
  const { store, key, identity, url, requestHeaders, response } = req;
  const responseHeadersObj = headersToObject(response.headers);

  const policy = new CachePolicy(
    { url, method: "GET", headers: requestHeaders },
    { status: response.status, headers: responseHeadersObj },
    POLICY_OPTIONS,
  );

  if (!policy.storable()) {
    return 0;
  }

  const text = await response.text();
  // Only JSON responses are cached. Throws for anything else, which the
  // caller treats as not storable.
  JSON.parse(text);
  const now = Date.now();

  // When the server sent explicit cache directives, use its TTL (even if 0).
  // Only fall back to URL-based tier when no server cache headers were present.
  const tier = classifyUrl(url);
  const ttl = hasServerCacheDirectives(policy)
    ? policy.timeToLive()
    : FALLBACK_TTL_MS[tier];

  const body = await codec.encode(encoder.encode(text));
  await store.set(
    key,
    {
      url,
      identity,
      tier,
      status: response.status,
      headers: pickHeaders(response.headers),
      body,
      policy: policy.toObject(),
      createdAt: now,
    },
    ttl,
  );
  return body.bytes.byteLength;
}

/**
 * Invalidate every cached GET whose URL starts with `prefix` and
 * belongs to the current identity. Best-effort; never throws.
 *
 * Cache keys already scope entries by identity (see {@link buildCacheKey}),
 * but a prefix sweep matches on `url`, so the store re-checks each entry's
 * identity before deleting it. Otherwise user A's mutation could evict user
 * B's cached entries on a shared cache dir. Entries written by older CLI
 * versions without an `identity` are treated as foreign.
 */
export async function invalidateCachedResponsesMatching(
  prefix: string,
  identity = getIdentityFingerprint(),
): Promise<void> {
  try {
    await getStore().deleteMatching(identity, prefix);
  } catch (error) {
    // Best-effort: the mutation has already succeeded upstream.
    log.debug("Failed to invalidate cached responses", error);
  }
}

/**
 * Remove all cached responses.
 * Called on `auth logout` and `auth login` since cached data is tied to the user.
 */
export async function clearResponseCache(): Promise<void> {
  try {
    await getStore().clear();
  } catch (error) {
    log.debug("Failed to clear the response cache", error);
  }
}
