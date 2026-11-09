/**
 * HTTP response cache for read-only API calls.
 *
 * Freshness, revalidation, and retention come from the shared cache policy
 * in `@sentry/api/client` (`lookupResponse` / `storeResponse`): server
 * `Cache-Control` / `ETag` / `Expires` headers win, and a URL-based fallback
 * TTL applies when the server sends none (Sentry's current behavior). This
 * module adds the CLI's store, identity, kill switches, telemetry, and
 * cache-age hint.
 *
 * Bodies are compressed with the toolkit-core codec and kept in a
 * filesystem store under `~/.sentry/cache/api-responses/` (see
 * `response-cache-store.ts`), separate from the config SQLite database, which
 * stores small structured data (tokens, org slugs, cursors).
 *
 * @module
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildCacheKey as buildIdentityCacheKey,
  type CacheLookup,
  classifyUrl,
  lookupResponse,
  storeResponse,
} from "@sentry/api/client";
import { createBodyCodec } from "@sentry/toolkit-core/response-cache/codec";

import { getIdentityFingerprint } from "./db/auth.js";
import { getConfigDir } from "./db/index.js";
import { getEnv, invocationState, isPersistenceDisabled } from "./env.js";
import { logger } from "./logger.js";
import { createFileStore, type FileStore } from "./response-cache-store.js";
import { recordCacheHit, withCacheSpan } from "./telemetry.js";

/** Tagged logger for diagnostic visibility into best-effort cache operations. */
const log = logger.withTag("response-cache");

// ---------------------------------------------------------------------------
// Cache keys — tiers, keys, and invalidation prefixes live in @sentry/api/client
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
// Internal helpers
// ---------------------------------------------------------------------------

/** Get the response cache directory path */
function getCacheDir(): string {
  return join(getConfigDir(), "cache", "api-responses");
}

/**
 * The directory CLI versions before `@sentry/api` 0.446.0 cached into. Their
 * entries can hold the raw `Authorization` header in the stored cache policy,
 * so it is deleted rather than migrated.
 */
function getLegacyCacheDir(): string {
  return join(getConfigDir(), "cache", "responses");
}

const codec = createBodyCodec();

let current: { dir: string; store: FileStore } | undefined;

/**
 * The store for the current config dir. Call it before any `await`, so a
 * fire-and-forget write finishes in the directory its request started in.
 */
function getStore(): FileStore {
  const dir = getCacheDir();
  if (current?.dir !== dir) {
    current = { dir, store: createFileStore({ dir }) };
    rm(getLegacyCacheDir(), { recursive: true, force: true }).catch((error) => {
      log.debug("Failed to delete the legacy response cache", error);
    });
  }
  return current.store;
}

// ---------------------------------------------------------------------------
// Per-invocation cache state: last cache-hit age and the `--fresh` bypass
// ---------------------------------------------------------------------------

/**
 * `lastHitAgeMs` is the age of the most recent cache hit. It is set inside
 * {@link lookupCachedResponse} on a hit and cleared at the start of each
 * `authenticatedFetch` call in `sentry-client.ts`. Commands read it via
 * {@link getLastCacheHitAge} to show "cached · 3m ago · use -f to refresh".
 *
 * `readBypassed` is set by `--fresh`. Both are per invocation, so one SDK
 * call never reports another call's cache hit or keeps its bypass.
 */
const cacheState = invocationState<{
  lastHitAgeMs: number | undefined;
  readBypassed: boolean;
}>(() => ({ lastHitAgeMs: undefined, readBypassed: false }));

/**
 * Get the age (in ms) of the most recent cache hit, or `undefined` if the
 * last request was not served from cache.
 */
export function getLastCacheHitAge(): number | undefined {
  return cacheState().lastHitAgeMs;
}

/**
 * Clear the last cache-hit age. Called at the top of each `authenticatedFetch`
 * call so the signal reflects only the current request.
 */
export function clearLastCacheHitAge(): void {
  cacheState().lastHitAgeMs = undefined;
}

/**
 * Set the last cache-hit age directly. Test-only — production code paths
 * set this implicitly via {@link lookupCachedResponse} on a real cache hit.
 *
 * @internal Exported for testing
 */
export function setLastCacheHitAgeForTesting(ageMs: number): void {
  cacheState().lastHitAgeMs = ageMs;
}

/**
 * Bypass cache reads for the current invocation.
 *
 * Called when `--fresh` flag is passed to a command. Fresh API responses are
 * still written to cache so subsequent invocations serve updated data.
 */
export function disableResponseCache(): void {
  cacheState().readBypassed = true;
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
  cacheState().readBypassed = false;
}

/**
 * Check if cache reads are disabled.
 * Reads are skipped when:
 * - `disableResponseCache()` was called (`--fresh` flag)
 * - `SENTRY_NO_CACHE=1` environment variable is set
 * - persistence is off for this invocation
 */
export function isCacheDisabled(): boolean {
  return cacheState().readBypassed || isCacheWriteDisabled();
}

/**
 * Check if cache writes are disabled.
 *
 * Only the `SENTRY_NO_CACHE=1` env var and persistence being off disable
 * writes. The `--fresh` flag intentionally allows writes so that the
 * freshly-fetched response replaces any stale cache entry.
 */
function isCacheWriteDisabled(): boolean {
  return getEnv().SENTRY_NO_CACHE === "1" || isPersistenceDisabled();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type { CacheLookup };

/**
 * Look up a GET request in the cache.
 *
 * A fresh entry is a `hit`, and a stale entry with an `ETag` is returned for
 * conditional revalidation (see `lookupResponse` in `@sentry/api/client`).
 *
 * @param method - HTTP method (only "GET" is cached)
 * @param url - Full request URL
 * @param requestHeaders - Headers from the new request
 * @returns The lookup result, or `undefined` on a miss
 */
export async function lookupCachedResponse(
  method: string,
  url: string,
  requestHeaders: Record<string, string>,
  identity = getIdentityFingerprint(),
): Promise<CacheLookup | undefined> {
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
    async (span): Promise<CacheLookup | undefined> => {
      const miss = (): void => {
        span.setAttribute("cache.hit", false);
        recordCacheHit("http", false);
      };

      try {
        const lookup = await lookupResponse({
          store,
          codec,
          key,
          url,
          requestHeaders,
          onRenewError: (error) =>
            log.debug("Failed to renew revalidated cache entry", error),
        });
        if (lookup?.kind !== "hit") {
          miss();
          return lookup;
        }

        span.setAttribute("cache.hit", true);
        recordCacheHit("http", true);
        span.setAttribute("cache.item_size", lookup.size);

        // Surface cache age for command-level hints (getsentry/cli#785 #1)
        cacheState().lastHitAgeMs = Date.now() - lookup.createdAt;
        return lookup;
      } catch (error) {
        // Corrupted or version-incompatible policy or body — treat as a miss
        // and drop the broken entry.
        log.debug("Dropping unreadable cache entry", error);
        await store.delete(key);
        miss();
        return;
      }
    },
    {
      "cache.key": [key],
      "network.peer.address": getCacheDir(),
    },
  );
}

/**
 * Attempt to serve a fresh cached response for a GET request.
 *
 * @returns A synthetic Response if cache hit, or undefined on miss/stale
 * @internal Exported for testing
 */
export async function getCachedResponse(
  method: string,
  url: string,
  requestHeaders: Record<string, string>,
  identity = getIdentityFingerprint(),
): Promise<Response | undefined> {
  const lookup = await lookupCachedResponse(
    method,
    url,
    requestHeaders,
    identity,
  );
  return lookup?.kind === "hit" ? lookup.response : undefined;
}

/**
 * Store a response in the cache.
 *
 * Only caches successful (2xx) GET responses that HTTP caching allows (see
 * `storeResponse` in `@sentry/api/client`); `Cache-Control: no-store` is not
 * cached.
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
        const size = await storeResponse({
          store,
          codec,
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
  if (isPersistenceDisabled()) {
    return;
  }
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
  if (isPersistenceDisabled()) {
    return;
  }
  try {
    await getStore().clear();
  } catch (error) {
    log.debug("Failed to clear the response cache", error);
  }
}
