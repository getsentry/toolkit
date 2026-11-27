/**
 * One GET through the cache: serve a fresh entry, revalidate a stale one
 * with its validators, serve the stale entry when the server fails (with
 * `staleIfError`), and store what the server sends back. A failure of the
 * cache itself is a miss, so it never fails the request.
 */

import type { BodyCodec } from "./body.js";
import { buildCacheKey } from "./keys.js";
import {
  type CacheLookup,
  type FreshnessOptions,
  lookupResponse,
  storeResponse,
} from "./policy.js";
import type { CacheStore } from "./store.js";

export type CachedFetchOptions = FreshnessOptions & {
  store: CacheStore;
  codec: BodyCodec;
  /**
   * Who the response belongs to: a stable hash of the credential or login
   * that `send` uses, never a raw token. An entry of one identity never
   * serves another.
   */
  identity: string;
  url: string;
  /**
   * Defaults to `buildCacheKey("GET", url, identity)`. Pass one to add
   * request parts that change the response, such as `Accept`.
   */
  key?: string;
  /** Headers `send` sends, for `Vary` matching. */
  requestHeaders?: Record<string, string>;
  /** Send the GET with these headers added, such as `If-None-Match`. */
  send: (headers: Record<string, string>) => Promise<Response>;
  /**
   * Called with the entry's `createdAt` when a stale entry is served
   * because `send` threw or the server answered 429 or 5xx.
   */
  onStale?: (createdAt: number) => void;
  /** Called when reading or writing the cache fails; the request stands. */
  onCacheError?: (error: unknown) => void;
  /** Store only JSON bodies. */
  requireJson?: boolean;
};

/**
 * A rate limit or server error says nothing about access, so it keeps the
 * entry, and may serve it with `staleIfError`.
 */
function isServerFailure(status: number): boolean {
  return status === 429 || status >= 500;
}

function freshness(options: FreshnessOptions): FreshnessOptions {
  const { ttlMs, maxTtlMs, retainMs, staleIfError } = options;
  return {
    ttlMs,
    ...(maxTtlMs === undefined ? {} : { maxTtlMs }),
    ...(retainMs === undefined ? {} : { retainMs }),
    ...(staleIfError === undefined ? {} : { staleIfError }),
  };
}

/**
 * Send one GET through the cache.
 *
 * A 403, 404, or other client error drops the entry, so a later error
 * cannot serve it to a credential that lost access.
 *
 * @throws What `send` throws, when no stale entry can be served instead
 */
export async function fetchWithCache(
  options: CachedFetchOptions,
): Promise<Response> {
  const { store, codec, identity, url, requestHeaders = {}, send } = options;
  const report = (error: unknown): void => options.onCacheError?.(error);
  const key = options.key ?? (await buildCacheKey("GET", url, identity));

  let lookup: CacheLookup | undefined;
  try {
    lookup = await lookupResponse({
      ...freshness(options),
      store,
      codec,
      key,
      url,
      requestHeaders,
      onRenewError: report,
    });
  } catch (error) {
    // A corrupt or unreadable entry is a miss; drop it.
    report(error);
    await store.delete(key).catch(report);
  }
  if (lookup?.kind === "hit") {
    return lookup.response;
  }
  const stale = lookup;

  async function serveStale(): Promise<Response | undefined> {
    if (!stale?.serveStale) {
      return;
    }
    try {
      const response = await stale.serveStale();
      if (response) {
        options.onStale?.(stale.createdAt);
      }
      return response;
    } catch (error) {
      report(error);
      return;
    }
  }

  /** The stale entry in place of a failed `send`, or the failure. */
  async function serveStaleOrThrow(error: unknown): Promise<Response> {
    const fallback = await serveStale();
    if (fallback) {
      return fallback;
    }
    throw error;
  }

  let response: Response;
  try {
    response = await send(stale?.conditionalHeaders ?? {});
  } catch (error) {
    return await serveStaleOrThrow(error);
  }
  if (stale && response.status === 304) {
    const revalidated = await stale.revalidate(response).catch(report);
    if (revalidated) {
      return revalidated;
    }
    // A 304 that does not match the entry: ask again without validators.
    try {
      response = await send({});
    } catch (error) {
      return await serveStaleOrThrow(error);
    }
  }

  if (isServerFailure(response.status)) {
    const fallback = await serveStale();
    if (!fallback) {
      return response;
    }
    // Some bodies finish cancelling only when their source does, so this
    // does not wait.
    response.body?.cancel().catch(() => undefined);
    return fallback;
  }
  if (!response.ok) {
    if (lookup) {
      await store.delete(key).catch(report);
    }
    return response;
  }

  try {
    await storeResponse({
      ...freshness(options),
      store,
      codec,
      key,
      identity,
      url,
      requestHeaders,
      response: response.clone(),
      ...(options.requireJson ? { requireJson: true } : {}),
    });
  } catch (error) {
    report(error);
  }
  return response;
}
