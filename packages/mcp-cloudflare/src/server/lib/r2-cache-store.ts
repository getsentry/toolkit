/**
 * The R2 tier of the hosted response cache, used when
 * `MCP_RESPONSE_CACHE=tiered`. It shares a few detail responses across
 * isolates: only URLs on {@link isR2Allowlisted}, and only when the server
 * opted in with `Cache-Control: private` and a positive `max-age`. Every
 * other entry stays in the isolate's memory.
 *
 * Objects are keyed `<identity>/<cache key>`, and each records its expiry,
 * the lesser of the server's `max-age` and 5 minutes, which reads enforce.
 * A 1-day bucket lifecycle rule only collects garbage.
 */

import * as Sentry from "@sentry/cloudflare";
import { logWarn } from "@sentry/mcp-core/telem/logging";
import type { CacheEntry, CacheStore } from "@sentry/api/client";

/** No R2 entry outlives this, whatever `max-age` the server sends. */
export const R2_MAX_TTL_MS = 5 * 60 * 1000;

/** Largest stored (compressed) body written to R2, as in the memory store. */
const MAX_R2_ENTRY_BYTES = 1024 * 1024;

/** Bumped when the object layout changes; other versions read as misses. */
const FORMAT_VERSION = "1";

const LOGGER_SCOPE = ["cloudflare", "response-cache"];
const R2_LOOKUP_METRIC = "app.response_cache.r2.lookup";
const R2_WRITE_METRIC = "app.response_cache.r2.write";

/**
 * Detail endpoints stable enough to share across isolates, each with the
 * query parameters that make a response live or privileged.
 */
const R2_URL_ALLOWLIST: readonly {
  path: RegExp;
  excludedParams: readonly string[];
}[] = [
  {
    // Organization event details; `averageColumn` reads live aggregates.
    path: /^\/api\/0\/organizations\/[^/]+\/events\/[^/:]+:[^/]+\/$/,
    excludedParams: ["averageColumn"],
  },
  {
    // Project trace-item details; `debug` adds internal fields.
    path: /^\/api\/0\/projects\/[^/]+\/[^/]+\/trace-items\/[^/]+\/$/,
    excludedParams: ["debug"],
  },
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Whether `url` may be persisted to R2 at all. */
export function isR2Allowlisted(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return R2_URL_ALLOWLIST.some(
    ({ path, excludedParams }) =>
      path.test(parsed.pathname) &&
      !excludedParams.some((name) => parsed.searchParams.has(name)),
  );
}

/**
 * The response's `Cache-Control`. Entries keep only `Link` in `headers`, so
 * it comes from the response headers in the serialized
 * `http-cache-semantics` policy (`resh`).
 */
function responseCacheControl(entry: CacheEntry): string {
  const { policy } = entry;
  if (typeof policy !== "object" || policy === null || !("resh" in policy)) {
    return "";
  }
  const { resh } = policy;
  if (typeof resh !== "object" || resh === null || !("cache-control" in resh)) {
    return "";
  }
  const value = resh["cache-control"];
  return typeof value === "string" ? value : "";
}

/**
 * How long R2 may keep `entry`: the server's `max-age` capped at
 * {@link R2_MAX_TTL_MS} when it sent `Cache-Control: private`, otherwise 0.
 */
export function r2TtlMs(entry: CacheEntry): number {
  const directives = responseCacheControl(entry)
    .toLowerCase()
    .split(",")
    .map((directive) => directive.trim());
  if (
    !directives.includes("private") ||
    directives.includes("no-store") ||
    directives.includes("no-cache")
  ) {
    return 0;
  }
  const maxAge = directives.find((directive) =>
    directive.startsWith("max-age="),
  );
  const seconds = Number(maxAge?.slice("max-age=".length));
  if (!(Number.isInteger(seconds) && seconds > 0)) {
    return 0;
  }
  return Math.min(seconds * 1000, R2_MAX_TTL_MS);
}

/** An entry as one object: a 4-byte metadata length, its JSON, then the body. */
function encodeEntry(entry: CacheEntry): Uint8Array {
  const { body, ...rest } = entry;
  const meta = encoder.encode(
    JSON.stringify({ ...rest, body: { ...body, bytes: undefined } }),
  );
  const bytes = new Uint8Array(4 + meta.byteLength + body.bytes.byteLength);
  new DataView(bytes.buffer).setUint32(0, meta.byteLength);
  bytes.set(meta, 4);
  bytes.set(body.bytes, 4 + meta.byteLength);
  return bytes;
}

function decodeEntry(bytes: Uint8Array): CacheEntry {
  const metaLength = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0);
  const meta = JSON.parse(
    decoder.decode(bytes.subarray(4, 4 + metaLength)),
  ) as Omit<CacheEntry, "body"> & {
    body: Omit<CacheEntry["body"], "bytes">;
  };
  return {
    ...meta,
    body: { ...meta.body, bytes: bytes.slice(4 + metaLength) },
  };
}

function recordR2Lookup(result: "hit" | "miss" | "expired"): void {
  Sentry.metrics.count(R2_LOOKUP_METRIC, 1, {
    attributes: { "app.response_cache.result": result },
  });
}

type TieredStoreOptions = {
  memory: CacheStore;
  bucket: R2Bucket;
  /** The identity every key belongs to; it prefixes each object key. */
  identity: string;
  /** Keeps R2 writes alive after the response is returned. */
  waitUntil: (promise: Promise<unknown>) => void;
};

/**
 * Memory first, then R2, for one identity's allowlisted URLs. The caller
 * picks this store only for {@link isR2Allowlisted} URLs. An R2 hit is copied
 * into memory for the time it has left. Writes go to memory, and also to R2
 * when the server opted in. Invalidation only touches memory: allowlisted
 * entries are never invalidated by writes, and they expire in 5 minutes.
 */
export function createTieredStore({
  memory,
  bucket,
  identity,
  waitUntil,
}: TieredStoreOptions): CacheStore {
  const objectKey = (key: string) => `${identity}/${key}`;

  async function readR2(key: string): Promise<CacheEntry | undefined> {
    const object = await bucket.get(objectKey(key));
    if (!object) {
      recordR2Lookup("miss");
      return;
    }
    const remainingMs = Number(object.customMetadata?.expiresAt) - Date.now();
    if (object.customMetadata?.v !== FORMAT_VERSION || !(remainingMs > 0)) {
      recordR2Lookup("expired");
      return;
    }
    const entry = decodeEntry(new Uint8Array(await object.arrayBuffer()));
    if (entry.identity !== identity) {
      recordR2Lookup("miss");
      return;
    }
    await memory.set(key, entry, remainingMs);
    recordR2Lookup("hit");
    return entry;
  }

  return {
    async get(key) {
      const cached = await memory.get(key);
      if (cached) {
        return cached;
      }
      try {
        return await readR2(key);
      } catch (error) {
        logWarn("Response cache R2 read failed", {
          loggerScope: LOGGER_SCOPE,
          extra: { error: String(error) },
        });
        return;
      }
    },

    async set(key, entry, ttlMs) {
      await memory.set(key, entry, ttlMs);
      const persistMs = r2TtlMs(entry);
      if (
        persistMs === 0 ||
        entry.identity !== identity ||
        entry.body.bytes.byteLength > MAX_R2_ENTRY_BYTES
      ) {
        return;
      }
      const expiresAt = entry.createdAt + persistMs;
      waitUntil(
        bucket
          .put(objectKey(key), encodeEntry(entry), {
            customMetadata: {
              v: FORMAT_VERSION,
              expiresAt: String(expiresAt),
            },
          })
          .then(() => Sentry.metrics.count(R2_WRITE_METRIC, 1))
          .catch((error: unknown) => {
            logWarn("Response cache R2 write failed", {
              loggerScope: LOGGER_SCOPE,
              extra: { error: String(error) },
            });
          }),
      );
    },

    async deleteMatching(entryIdentity, urlPrefix) {
      await memory.deleteMatching(entryIdentity, urlPrefix);
    },
  };
}
