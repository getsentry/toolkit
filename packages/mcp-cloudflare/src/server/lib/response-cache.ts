/**
 * The hosted MCP's Sentry API response cache, behind `MCP_RESPONSE_CACHE`:
 * `off` (the default, and any unknown value), `memory`, or `tiered`.
 *
 * Entries live in one byte-budgeted memory store per isolate, shared by every
 * request it serves. `tiered` also shares a few allowlisted detail responses
 * across isolates through R2 (see `r2-cache-store.ts`). Each entry is keyed
 * by an identity hashed from the MCP grant (the wrapper token's user and
 * grant IDs), so one grant never reads another's responses. Requests
 * without a grant, such as Sentry-Bearer direct tokens, are not cached.
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
} from "@sentry/toolkit-core/api-client/response-cache";
import { createBodyCodec } from "@sentry/toolkit-core/response-cache/codec";
import { createTieredStore, isR2Allowlisted } from "./r2-cache-store";

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
let missingBucketLogged = false;

/**
 * The cache mode for `MCP_RESPONSE_CACHE`. Anything other than `memory` or
 * `tiered` is `off`.
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
  return await sha256Hex(JSON.stringify(["mcp-grant", userId, grantId]));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Request headers for `Vary` matching with the Authorization value hashed.
 * A response that varies on Authorization makes the cache policy keep the
 * request's headers, and an entry must never hold a raw token.
 */
async function hashAuthorization(
  requestHeaders: Record<string, string>,
): Promise<Record<string, string>> {
  const { authorization, ...rest } = requestHeaders;
  return authorization
    ? { ...rest, authorization: `sha256:${await sha256Hex(authorization)}` }
    : rest;
}

function recordLookup(result: "hit" | "miss" | "stale"): void {
  Sentry.metrics.count(LOOKUP_METRIC, 1, {
    attributes: { "app.response_cache.result": result },
  });
}

/**
 * A memory store that reports each write with its body encoding, evictions,
 * and its usage after each write, and logs the first time it reaches
 * `maxBytes`.
 */
export function createMeteredMemoryStore(
  maxBytes = MEMORY_BUDGET_BYTES,
): MemoryStore {
  let budgetReached = false;
  const store: MemoryStore = createMemoryStore({
    maxBytes,
    onEvict: () => {
      Sentry.metrics.count(EVICTION_METRIC, 1);
      if (!budgetReached) {
        budgetReached = true;
        logInfo("Response cache reached its memory budget", {
          loggerScope: LOGGER_SCOPE,
          extra: { budgetBytes: maxBytes, ...store.stats() },
        });
      }
    },
  });
  return {
    ...store,
    async set(key, entry, ttlMs) {
      await store.set(key, entry, ttlMs);
      Sentry.metrics.count(WRITE_METRIC, 1, {
        attributes: { "app.response_cache.encoding": entry.body.encoding },
      });
      const { bytes, entries } = store.stats();
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
  /** Used instead of `store` for R2-allowlisted URLs. */
  allowlistedStore?: CacheStore;
  identity: string;
  /** The Sentry host's base URL, for cross-endpoint invalidation rules. */
  apiBaseUrl: string;
  /** Keeps cache writes alive after the response is returned. */
  waitUntil: (promise: Promise<unknown>) => void;
};

/**
 * A response cache over `store` for one identity, in the shape
 * `ServerContext.responseCache` takes.
 */
export function createResponseCache({
  store,
  allowlistedStore,
  identity,
  apiBaseUrl,
  waitUntil,
}: ResponseCacheOptions): ResponseCache {
  const storeFor = (url: string) =>
    allowlistedStore && isR2Allowlisted(url) ? allowlistedStore : store;

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
        store: storeFor(url),
        codec,
        key,
        identity,
        url,
        requestHeaders: await hashAuthorization(requestHeaders),
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
            store: storeFor(url),
            codec,
            key,
            url,
            requestHeaders: await hashAuthorization(requestHeaders),
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
        waitUntil(pending);
        return pending;
      },

      async invalidate(url) {
        for (const prefix of computeInvalidationPrefixes(url, apiBaseUrl)) {
          await store.deleteMatching(identity, prefix);
        }
      },
    },
  };
}

/**
 * The response cache for one MCP request under `mode`, or `undefined` when
 * caching is off. `tiered` without a `bucket` caches in memory only.
 */
export async function getResponseCache({
  mode,
  bucket,
  userId,
  grantId,
  sentryHost,
  waitUntil,
}: {
  mode: ResponseCacheMode;
  bucket: R2Bucket | undefined;
  userId: string;
  grantId: string;
  sentryHost: string;
  waitUntil: (promise: Promise<unknown>) => void;
}) {
  if (mode === "off") {
    return;
  }
  if (mode === "tiered" && !bucket && !missingBucketLogged) {
    missingBucketLogged = true;
    logWarn("MCP_RESPONSE_CACHE=tiered without an R2 bucket; using memory", {
      loggerScope: LOGGER_SCOPE,
    });
  }
  const memory = (memoryStore ??= createMeteredMemoryStore());
  const identity = await getGrantCacheIdentity(userId, grantId);
  return createResponseCache({
    store: memory,
    allowlistedStore:
      mode === "tiered" && bucket
        ? createTieredStore({ memory, bucket, identity, waitUntil })
        : undefined,
    identity,
    apiBaseUrl: `https://${sentryHost}`,
    waitUntil,
  });
}
