/**
 * The hosted MCP's Sentry API response cache, behind `MCP_RESPONSE_CACHE`:
 * `off` (the default, and any unknown value), `memory`, or `tiered`.
 *
 * Entries live in one byte-budgeted memory store per isolate, shared by every
 * request it serves. Each entry is keyed by an identity hashed from the MCP
 * grant (the wrapper token's user and grant IDs), so one grant never reads
 * another's responses. Requests without a grant, such as Sentry-Bearer
 * direct tokens, are not cached.
 */

import * as Sentry from "@sentry/cloudflare";
import { logInfo, logWarn } from "@sentry/mcp-core/telem/logging";
import type { ResponseCache } from "@sentry/mcp-core/types";
import {
  buildCacheKey,
  type CacheStore,
  classifyUrl,
  computeInvalidationPrefixes,
  createMemoryStore,
  lookupResponse,
  type MemoryStore,
  storeResponse,
} from "@sentry/api/client";
import { createBodyCodec } from "@sentry/toolkit-core/response-cache/codec";

export type ResponseCacheMode = "off" | "memory" | "tiered";

/** Per-isolate budget over all entries; a Worker isolate has 128 MB. */
const MEMORY_BUDGET_BYTES = 24 * 1024 * 1024;

const LOGGER_SCOPE = ["cloudflare", "response-cache"];
const LOOKUP_METRIC = "app.response_cache.lookup";
const WRITE_METRIC = "app.response_cache.write";
const EVICTION_METRIC = "app.response_cache.eviction";
const MEMORY_BYTES_METRIC = "app.response_cache.memory.bytes";
const MEMORY_ENTRIES_METRIC = "app.response_cache.memory.entries";

const encoder = new TextEncoder();
const codec = createBodyCodec();

/** The isolate's store, shared by every request it serves. */
let memoryStore: MemoryStore | undefined;

/**
 * The cache mode for `MCP_RESPONSE_CACHE`. Anything other than `memory` or
 * `tiered` is `off`. `tiered` caches in memory only until the R2 tier lands.
 */
export function resolveResponseCacheMode(
  value: string | undefined,
): ResponseCacheMode {
  const mode = value?.trim().toLowerCase();
  return mode === "memory" || mode === "tiered" ? mode : "off";
}

/**
 * The cache identity for an MCP grant: a SHA-256 of the user and grant IDs,
 * so entries are never keyed by a raw ID. The grant ID stays the same when
 * the wrapper token refreshes, and the grant has one Sentry user behind it.
 */
export async function getGrantCacheIdentity(
  userId: string,
  grantId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(JSON.stringify(["mcp-grant", userId, grantId])),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function recordLookup(result: "hit" | "miss" | "stale"): void {
  Sentry.metrics.count(LOOKUP_METRIC, 1, {
    attributes: { "app.response_cache.result": result },
  });
}

/**
 * A memory store that reports each write it keeps, with its body encoding,
 * evictions, and its usage after each write, and logs the first time it
 * reaches `maxBytes`. Writes it rejects, such as oversized bodies, are not
 * counted.
 *
 * The store has no eviction hook, so `set` derives evictions from its entry
 * count. Reading the key before and after the write separates the entry it
 * replaces, or one that expired, from entries evicted for the budget.
 */
export function createMeteredMemoryStore(
  maxBytes = MEMORY_BUDGET_BYTES,
): MemoryStore {
  let budgetReached = false;
  const store = createMemoryStore({ maxBytes });

  function recordEvictions(count: number): void {
    if (count <= 0) {
      return;
    }
    Sentry.metrics.count(EVICTION_METRIC, count);
    if (!budgetReached) {
      budgetReached = true;
      logInfo("Response cache reached its memory budget", {
        loggerScope: LOGGER_SCOPE,
        extra: { budgetBytes: maxBytes, ...store.stats() },
      });
    }
  }

  return {
    ...store,
    async set(key, entry, ttlMs) {
      const replaced = (await store.get(key)) !== undefined;
      const before = store.stats().entries;
      await store.set(key, entry, ttlMs);
      const stored = (await store.get(key)) !== undefined;
      const { bytes, entries } = store.stats();
      recordEvictions(before - (replaced ? 1 : 0) + (stored ? 1 : 0) - entries);
      if (stored) {
        Sentry.metrics.count(WRITE_METRIC, 1, {
          attributes: { "app.response_cache.encoding": entry.body.encoding },
        });
      }
      Sentry.metrics.gauge(MEMORY_BYTES_METRIC, bytes);
      Sentry.metrics.gauge(MEMORY_ENTRIES_METRIC, entries);
    },
  };
}

function isJson(response: Response): boolean {
  return /\bjson\b/i.test(response.headers.get("content-type") ?? "");
}

export type ResponseCacheOptions = {
  store: CacheStore;
  identity: string;
  /** The Sentry host's base URL, for cross-endpoint invalidation rules. */
  apiBaseUrl: string;
  /** Keeps cache writes alive after the response is returned. */
  waitUntil: (promise: Promise<unknown>) => void;
};

/**
 * Writes still running in `waitUntil`, by store and identity. Invalidation
 * waits for them, so a GET's write that is still running when a mutation
 * invalidates cannot land afterwards and bring the old body back.
 */
const pendingWrites = new WeakMap<
  CacheStore,
  Map<string, Set<Promise<void>>>
>();

function trackWrite(
  store: CacheStore,
  identity: string,
  write: Promise<void>,
): void {
  let byIdentity = pendingWrites.get(store);
  if (!byIdentity) {
    byIdentity = new Map();
    pendingWrites.set(store, byIdentity);
  }
  let writes = byIdentity.get(identity);
  if (!writes) {
    writes = new Set();
    byIdentity.set(identity, writes);
  }
  writes.add(write);
  const tracked = writes;
  void write.finally(() => {
    tracked.delete(write);
    if (tracked.size === 0 && byIdentity.get(identity) === tracked) {
      byIdentity.delete(identity);
    }
  });
}

/**
 * A response cache over `store` for one identity, in the shape
 * `ServerContext.responseCache` takes.
 */
export function createResponseCache({
  store,
  identity,
  apiBaseUrl,
  waitUntil,
}: ResponseCacheOptions): ResponseCache {
  async function write(
    url: string,
    requestHeaders: Record<string, string>,
    response: Response,
  ): Promise<void> {
    try {
      // Skip non-JSON bodies, such as attachments, before reading them.
      if (classifyUrl(url) === "no-cache" || !isJson(response)) {
        return;
      }
      const key = await buildCacheKey("GET", url, identity);
      await storeResponse({
        store,
        codec,
        key,
        identity,
        url,
        requestHeaders,
        response,
      });
    } finally {
      // Release the transport's copy of the body when nothing read it.
      if (!response.bodyUsed) {
        response.body?.cancel().catch(() => {});
      }
    }
  }

  return {
    identity,
    cache: {
      async lookup({ url, requestHeaders }) {
        if (classifyUrl(url) === "no-cache") {
          return;
        }
        try {
          const key = await buildCacheKey("GET", url, identity);
          const lookup = await lookupResponse({
            store,
            codec,
            key,
            url,
            requestHeaders,
          });
          recordLookup(lookup?.kind ?? "miss");
          return lookup;
        } catch (error) {
          // A corrupt entry is a miss; the next response replaces it.
          logWarn("Response cache lookup failed", {
            loggerScope: LOGGER_SCOPE,
            extra: { error: String(error) },
          });
          recordLookup("miss");
          return;
        }
      },

      store({ url, requestHeaders }, response) {
        const pending = write(url, requestHeaders, response).catch(
          (error: unknown) => {
            logWarn("Response cache write failed", {
              loggerScope: LOGGER_SCOPE,
              extra: { error: String(error) },
            });
          },
        );
        trackWrite(store, identity, pending);
        waitUntil(pending);
        return pending;
      },

      async invalidate(url) {
        const writes = pendingWrites.get(store)?.get(identity);
        if (writes) {
          await Promise.all(writes);
        }
        for (const prefix of computeInvalidationPrefixes(url, apiBaseUrl)) {
          await store.deleteMatching(identity, prefix);
        }
      },
    },
  };
}

/**
 * The response cache for one MCP request under `mode`, or `undefined` when
 * caching is off.
 */
export async function getResponseCache({
  mode,
  userId,
  grantId,
  sentryHost,
  waitUntil,
}: {
  mode: ResponseCacheMode;
  userId: string;
  grantId: string;
  sentryHost: string;
  waitUntil: (promise: Promise<unknown>) => void;
}) {
  if (mode === "off") {
    return;
  }
  return createResponseCache({
    store: (memoryStore ??= createMeteredMemoryStore()),
    identity: await getGrantCacheIdentity(userId, grantId),
    apiBaseUrl: `https://${sentryHost}`,
    waitUntil,
  });
}
