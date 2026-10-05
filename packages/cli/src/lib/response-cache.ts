/**
 * Filesystem-based HTTP response cache for read-only API calls.
 *
 * Uses `http-cache-semantics` (RFC 7234/9111) to make correct caching decisions.
 * When the server provides `Cache-Control` / `ETag` / `Expires` headers, they
 * are respected automatically. When the server sends no cache headers (Sentry's
 * current behavior), a URL-based fallback TTL is applied.
 *
 * Cache entries are stored as individual JSON files under `~/.sentry/cache/responses/`.
 * This keeps the response data separate from the config SQLite database, which
 * stores small structured data (tokens, org slugs, cursors). API responses can
 * be 50–500 KB each, so a dedicated cache directory avoids bloating the DB.
 *
 * @module
 */

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import CachePolicy from "http-cache-semantics";
import pLimit from "p-limit";

import { getIdentityFingerprint } from "./db/auth.js";
import { getConfigDir } from "./db/index.js";
import { getEnv } from "./env.js";
import { logger } from "./logger.js";
import { recordCacheHit, withCacheSpan } from "./telemetry.js";

/** Tagged logger for diagnostic visibility into best-effort cache operations. */
const log = logger.withTag("response-cache");

// ---------------------------------------------------------------------------
// TTL tiers — used as fallback when the server sends no cache headers
// ---------------------------------------------------------------------------

/**
 * TTL tier classification for URLs.
 *
 * - `immutable`: data that never changes once created (events, traces)
 * - `stable`: data that changes infrequently (orgs, projects, teams)
 * - `volatile`: data that changes often (issue lists, log lists)
 * - `no-cache`: never cache (polling endpoints like autofix state)
 */
type TtlTier = "immutable" | "stable" | "volatile" | "no-cache";

/** Fallback TTL durations by tier (milliseconds). `no-cache` uses 0 as a sentinel. */
const FALLBACK_TTL_MS: Record<TtlTier, number> = {
  immutable: 24 * 60 * 60 * 1000, // 24 hours — events and traces never change
  stable: 5 * 60 * 1000, // 5 minutes
  volatile: 60 * 1000, // 60 seconds
  "no-cache": 0,
};

/**
 * URL patterns grouped by TTL tier.
 *
 * Checked in tier priority order (no-cache → immutable → volatile).
 * "stable" has no patterns — it is the default fallback when nothing else matches.
 */
const URL_TIER_REGEXPS: Readonly<Record<TtlTier, readonly RegExp[]>> = {
  // Polling endpoints where state changes rapidly
  "no-cache": [/\/(?:autofix|root-cause)\//],
  // Specific resources by ID (events, traces, span details) — never change once created
  immutable: [
    /\/events\/[^/?]+\/?(?:\?|$)/,
    /\/trace\/[0-9a-f]{32}\//,
    /\/trace-items\/[0-9a-f]+\//,
  ],
  // Issue endpoints (lists AND detail views), dataset queries, trace-logs
  volatile: [/\/issues\//, /[?&]dataset=(?:logs|spans)/, /\/trace-logs\//],
  // Default fallback — no patterns needed
  stable: [],
};

/** Tier check order — stable is the default and has no patterns to check. */
const TIER_CHECK_ORDER: readonly TtlTier[] = [
  "no-cache",
  "immutable",
  "volatile",
];

/**
 * Classify a URL into a TTL tier for fallback caching.
 *
 * @param url - Full URL string (with query params)
 * @returns The TTL tier
 * @internal Exported for testing
 */
export function classifyUrl(url: string): TtlTier {
  for (const tier of TIER_CHECK_ORDER) {
    for (const pattern of URL_TIER_REGEXPS[tier]) {
      if (pattern.test(url)) {
        return tier;
      }
    }
  }
  return "stable";
}

// ---------------------------------------------------------------------------
// Cache key generation
// ---------------------------------------------------------------------------

/**
 * Build a deterministic cache key from the active identity + method + URL.
 *
 * Query params are sorted alphabetically so `?a=1&b=2` and `?b=2&a=1`
 * produce the same key. The identity fingerprint scopes entries per
 * bearer token so switching accounts never serves another user's data.
 *
 * @internal Exported for testing
 */
export function buildCacheKey(method: string, url: string): string {
  const normalized = normalizeUrl(method, url);
  return createHash("sha256")
    .update(`${getIdentityFingerprint()}|${normalized}`)
    .digest("hex");
}

/**
 * Normalize method + URL into a stable string for cache key derivation.
 * Sorts query params alphabetically for deterministic key generation.
 *
 * @throws {TypeError} If the URL cannot be parsed
 * @internal Exported for testing
 */
export function normalizeUrl(method: string, url: string): string {
  const parsed = new URL(url);
  const sortedParams = new URLSearchParams(
    [...parsed.searchParams.entries()].sort(([a], [b]) => {
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    })
  );
  parsed.search = sortedParams.toString() ? `?${sortedParams.toString()}` : "";
  return `${method.toUpperCase()}|${parsed.toString()}`;
}

// ---------------------------------------------------------------------------
// Cache storage types and constants
// ---------------------------------------------------------------------------

/** Shape of a serialized cache entry on disk */
type CacheEntry = {
  /** Serialized CachePolicy object (via policy.toObject()) */
  policy: CachePolicy.CachePolicyObject;
  /** Response body (already parsed JSON) */
  body: unknown;
  /** HTTP status code */
  status: number;
  /** Selected response headers (e.g., Link for pagination) */
  headers: Record<string, string>;
  /** Original URL, used for TTL tier classification during cleanup */
  url: string;
  /**
   * Identity fingerprint that owns this entry. Used by
   * {@link invalidateCachedResponsesMatching} to skip other identities'
   * files. Optional for backwards compat: legacy entries are treated
   * as foreign and skipped.
   */
  identity?: string;
  /** When this entry was created (epoch ms) */
  createdAt: number;
  /**
   * Pre-computed expiry timestamp (epoch ms).
   * Allows cleanup to check freshness without deserializing CachePolicy.
   * Optional for backwards compatibility with entries written before this field.
   */
  expiresAt?: number;
};

/** CachePolicy options for a single-user CLI cache */
const POLICY_OPTIONS: CachePolicy.Options = {
  shared: false,
  cacheHeuristic: 0.1,
  immutableMinTimeToLive: FALLBACK_TTL_MS.immutable,
};

/** Maximum number of cache files to retain */
const MAX_CACHE_ENTRIES = 500;

/** Probability of running cleanup on each cache write */
const CLEANUP_PROBABILITY = 0.1;

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

/** Get the full file path for a cache key */
function cacheFilePath(key: string): string {
  return join(getCacheDir(), `${key}.json`);
}

/** Check if an error is an ENOENT (file/directory not found) */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
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
  url: string
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
  entry: CacheEntry
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
 * Reads the cache file directly and handles ENOENT (cache miss) without a
 * separate existence check. Reconstructs the `CachePolicy` from the stored
 * metadata and verifies the cached response still satisfies the new request.
 *
 * @param method - HTTP method (only "GET" is cached)
 * @param url - Full request URL
 * @param requestHeaders - Headers from the new request
 * @returns A synthetic Response if cache hit, or undefined on miss/expired
 */
export async function getCachedResponse(
  method: string,
  url: string,
  requestHeaders: Record<string, string>
): Promise<Response | undefined> {
  if (
    method !== "GET" ||
    isCacheDisabled() ||
    classifyUrl(url) === "no-cache"
  ) {
    return;
  }

  let key: string;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    key = buildCacheKey(method, url);
  } catch {
    // Malformed URL — skip cache lookup. The request itself will surface
    // any real URL error.
    return;
  }

  return await withCacheSpan(
    url,
    "cache.get",
    async (span) => {
      const entry = await readCacheEntry(key);
      if (!entry) {
        span.setAttribute("cache.hit", false);
        recordCacheHit("http", false);
        return;
      }

      try {
        const policy = CachePolicy.fromObject(entry.policy);
        if (!isEntryFresh(policy, entry, requestHeaders, url)) {
          span.setAttribute("cache.hit", false);
          recordCacheHit("http", false);
          return;
        }

        const body = JSON.stringify(entry.body);
        span.setAttribute("cache.hit", true);
        recordCacheHit("http", true);
        span.setAttribute("cache.item_size", body.length);

        // Surface cache age for command-level hints (getsentry/cli#785 #1)
        lastCacheHitAgeMs = Date.now() - entry.createdAt;

        const responseHeaders = buildResponseHeaders(policy, entry);
        return new Response(body, {
          status: entry.status,
          headers: responseHeaders,
        });
      } catch {
        // Corrupted or version-incompatible policy object — treat as cache miss.
        // Best-effort cleanup of the broken entry.
        span.setAttribute("cache.hit", false);
        recordCacheHit("http", false);
        // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
        unlink(cacheFilePath(key)).catch(() => {
          // Ignored — fire-and-forget
        });
        return;
      }
    },
    {
      "cache.key": [key],
      "network.peer.address": getCacheDir(),
    }
  );
}

/**
 * Read and parse a cache entry from disk.
 * Returns undefined on ENOENT or parse errors.
 */
async function readCacheEntry(key: string): Promise<CacheEntry | undefined> {
  const filePath = cacheFilePath(key);
  let raw: string;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    // ENOENT = cache miss; other read errors = treat as miss
    return;
  }

  try {
    return JSON.parse(raw) as CacheEntry;
  } catch {
    // Corrupted cache file — delete it
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    await unlink(filePath).catch(() => {
      // Best-effort cleanup of corrupted file
    });
    return;
  }
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
  response: Response
): Promise<void> {
  if (
    method !== "GET" ||
    isCacheWriteDisabled() ||
    !response.ok ||
    classifyUrl(url) === "no-cache"
  ) {
    return;
  }

  let key: string;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    key = buildCacheKey(method, url);
  } catch {
    // Malformed URL — skip caching this response
    return;
  }

  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    await withCacheSpan(
      url,
      "cache.put",
      async (span) => {
        const size = await writeResponseToCache({
          key,
          identity: getIdentityFingerprint(),
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
      }
    );
  } catch {
    // Cache write failures are non-fatal — silently ignore
  }
}

/**
 * Atomically write a cache file by writing to a unique temp file in the same
 * directory and renaming it into place.
 *
 * A plain `writeFile` is not atomic: a concurrent reader (e.g. the probabilistic
 * {@link cleanupCache} sweep fired fire-and-forget by an earlier write) can read
 * the file mid-write, fail to `JSON.parse` the truncated content, and delete it
 * as "corrupted" — silently losing a valid cache entry. `rename` into place is
 * atomic on POSIX (same filesystem) and near-atomic on Windows (same volume), so
 * a concurrent reader sees either the complete old file or the complete new file
 * rather than a half-written one.
 *
 * Best-effort cleanup of the temp file on failure; the caller treats write
 * failures as non-fatal.
 */
async function atomicWriteCacheFile(
  finalPath: string,
  serialized: string
): Promise<void> {
  const tmpPath = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, serialized, "utf-8");
    await rename(tmpPath, finalPath);
  } catch (error) {
    await unlink(tmpPath).catch((cleanupError) => {
      // The temp file may never have been created (e.g. writeFile failed).
      log.debug("Failed to clean up cache temp file", cleanupError);
    });
    throw error;
  }
}

/** Inputs for {@link writeResponseToCache}, bundled to stay under useMaxParams. */
type WriteRequest = {
  key: string;
  identity: string;
  url: string;
  requestHeaders: Record<string, string>;
  response: Response;
};

/**
 * Core cache write logic. Always called for GET requests.
 *
 * @returns Serialized body size in bytes (0 if not storable).
 */
async function writeResponseToCache(req: WriteRequest): Promise<number> {
  const { key, identity, url, requestHeaders, response } = req;
  const responseHeadersObj = headersToObject(response.headers);

  const policy = new CachePolicy(
    { url, method: "GET", headers: requestHeaders },
    { status: response.status, headers: responseHeadersObj },
    POLICY_OPTIONS
  );

  if (!policy.storable()) {
    return 0;
  }

  const body: unknown = await response.json();
  const now = Date.now();

  // Pre-compute expiry for cheap cleanup checks (avoids CachePolicy deserialization).
  // When the server sent explicit cache directives, use its TTL (even if 0).
  // Only fall back to URL-based tier when no server cache headers were present.
  const serverTtl = policy.timeToLive();
  const ttl = hasServerCacheDirectives(policy)
    ? serverTtl
    : FALLBACK_TTL_MS[classifyUrl(url)];

  const entry: CacheEntry = {
    policy: policy.toObject(),
    body,
    status: response.status,
    headers: pickHeaders(response.headers),
    url,
    identity,
    createdAt: now,
    expiresAt: now + ttl,
  };

  const serialized = JSON.stringify(entry);
  await mkdir(getCacheDir(), { recursive: true, mode: 0o700 });
  await atomicWriteCacheFile(cacheFilePath(key), serialized);

  // Probabilistic cleanup to avoid unbounded cache growth
  if (Math.random() < CLEANUP_PROBABILITY) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    cleanupCache().catch(() => {
      // Non-fatal: cleanup failure doesn't affect cache correctness
    });
  }

  return serialized.length;
}

/**
 * Invalidate every cached GET whose URL starts with `prefix` and
 * belongs to the current identity. Best-effort; never throws.
 *
 * Cache filenames already scope entries by identity (see
 * {@link buildCacheKey}), but a prefix sweep has to read every file
 * to match on `url` — so we re-check `entry.identity` before deleting,
 * otherwise user A's mutation could evict user B's cached entries on
 * a shared cache dir. Entries written by older CLI versions lack the
 * `identity` field and are treated as foreign.
 */
export async function invalidateCachedResponsesMatching(
  prefix: string
): Promise<void> {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const cacheDir = getCacheDir();
    const files = await readdir(cacheDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    if (jsonFiles.length === 0) {
      return;
    }

    const currentIdentity = getIdentityFingerprint();

    await cacheIO.map(jsonFiles, async (file) => {
      const filePath = join(cacheDir, file);
      // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        const raw = await readFile(filePath, "utf-8");
        const entry = JSON.parse(raw) as CacheEntry;
        if (
          entry.identity === currentIdentity &&
          entry.url?.startsWith(prefix)
        ) {
          // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
          await unlink(filePath).catch(() => {
            /* another process may have deleted it */
          });
        }
      } catch {
        /* unparseable/missing — leave to cleanup */
      }
    });
  } catch {
    /* best-effort: mutation has already succeeded upstream */
  }
}

/**
 * Remove all cached responses.
 * Called on `auth logout` and `auth login` since cached data is tied to the user.
 */
export async function clearResponseCache(): Promise<void> {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    await rm(getCacheDir(), { recursive: true, force: true });
  } catch {
    // Ignore errors — directory may not exist
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/** Concurrency limit for parallel cache file I/O operations */
const CACHE_IO_CONCURRENCY = 8;

/** Shared concurrency limiter for all cache I/O — created once, reused across calls */
const cacheIO = pLimit(CACHE_IO_CONCURRENCY);

// ---------------------------------------------------------------------------
// Cache cleanup
// ---------------------------------------------------------------------------

/**
 * Clean up expired and excess cache entries.
 *
 * Deletes entries that have expired (based on server TTL or fallback TTL),
 * then enforces a maximum entry count by evicting the oldest entries.
 */
async function cleanupCache(): Promise<void> {
  const cacheDir = getCacheDir();
  let files: string[];
  try {
    files = await readdir(cacheDir);
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }

  // Sweep orphaned temp files left by a crash between writeFile and rename in
  // {@link atomicWriteCacheFile}. Done regardless of whether any .json files
  // exist so leaked temp files can never accumulate unbounded.
  const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
  if (tmpFiles.length > 0) {
    await deleteStaleTempFiles(cacheDir, tmpFiles);
  }

  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  if (jsonFiles.length === 0) {
    return;
  }

  const entries = await collectEntryMetadata(cacheDir, jsonFiles);

  // Both operations are best-effort — run them in parallel without blocking
  await Promise.all([
    deleteExpiredEntries(cacheDir, entries),
    evictExcessEntries(cacheDir, entries),
  ]);
}

/**
 * Age (ms) after which an orphaned `.tmp` file is considered abandoned.
 *
 * A live {@link atomicWriteCacheFile} writes then renames in well under a
 * second, so any `.tmp` file older than this was left by a crashed process and
 * is safe to remove. The generous threshold avoids racing a concurrent write.
 */
const STALE_TEMP_FILE_MS = 60_000;

/** Delete `.tmp` files older than {@link STALE_TEMP_FILE_MS}. Best-effort. */
async function deleteStaleTempFiles(
  cacheDir: string,
  tmpFiles: string[]
): Promise<void> {
  const cutoff = Date.now() - STALE_TEMP_FILE_MS;
  await cacheIO.map(tmpFiles, async (file) => {
    const filePath = join(cacheDir, file);
    try {
      const stats = await stat(filePath);
      if (stats.mtimeMs < cutoff) {
        // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
        await unlink(filePath).catch(() => {
          // Already gone — another sweep or the owning process removed it.
        });
      }
    } catch (error) {
      log.debug("Failed to inspect cache temp file during sweep", error);
    }
  });
}

/** Metadata for a cache entry, used for cleanup decisions */
type EntryMetadata = { file: string; createdAt: number; expired: boolean };

/**
 * Read all cache files and determine which are expired.
 *
 * Uses the pre-computed `expiresAt` field when available (cheap — no
 * CachePolicy deserialization). Falls back to URL-based TTL classification
 * for entries written before `expiresAt` was added.
 */
async function collectEntryMetadata(
  cacheDir: string,
  jsonFiles: string[]
): Promise<EntryMetadata[]> {
  const entries: EntryMetadata[] = [];
  const now = Date.now();

  await cacheIO.map(jsonFiles, async (file) => {
    const filePath = join(cacheDir, file);

    // Read and parse are handled separately so we can distinguish a transient
    // read failure (skip — never delete) from genuine corruption (parse failed
    // on a fully-read file — safe to delete). Atomic writes
    // ({@link atomicWriteCacheFile}) guarantee readers never see a half-written
    // file, so a parse failure here means real corruption, not a torn read —
    // deleting was previously a data-loss bug when writes were non-atomic.
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (error) {
      // Transient read failure (locking, AV scanner, ENOENT from a concurrent
      // sweep). Skip — a later sweep will reconsider the file.
      log.debug("Skipping cache file with unreadable contents", error);
      return;
    }

    try {
      const entry = JSON.parse(raw) as CacheEntry;
      const expired =
        entry.expiresAt !== undefined
          ? now >= entry.expiresAt
          : now - entry.createdAt >
            FALLBACK_TTL_MS[classifyUrl(entry.url ?? "")];
      entries.push({ file, createdAt: entry.createdAt, expired });
    } catch (error) {
      // Fully read but unparseable — genuine corruption. Mark expired so
      // {@link deleteExpiredEntries} reclaims it; this also keeps eviction
      // counts accurate (corrupt files are not invisible to MAX_CACHE_ENTRIES).
      log.debug("Reclaiming corrupt cache file during cleanup", error);
      entries.push({ file, createdAt: now, expired: true });
    }
  });

  return entries;
}

/** Delete cache files that have expired */
async function deleteExpiredEntries(
  cacheDir: string,
  entries: EntryMetadata[]
): Promise<void> {
  const expired = entries.filter((e) => e.expired);
  await cacheIO.map(expired, (entry) =>
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    unlink(join(cacheDir, entry.file)).catch(() => {
      // Best-effort: file may have been deleted by another process
    })
  );
}

/** Evict the oldest entries when over the max count */
async function evictExcessEntries(
  cacheDir: string,
  entries: EntryMetadata[]
): Promise<void> {
  const remaining = entries.filter((e) => !e.expired);
  if (remaining.length <= MAX_CACHE_ENTRIES) {
    return;
  }

  remaining.sort((a, b) => a.createdAt - b.createdAt);
  const toEvict = remaining.slice(0, remaining.length - MAX_CACHE_ENTRIES);
  await cacheIO.map(toEvict, (entry) =>
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    unlink(join(cacheDir, entry.file)).catch(() => {
      // Best-effort eviction
    })
  );
}
