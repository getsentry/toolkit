/**
 * HTTP caching decisions for GET responses, through `http-cache-semantics`
 * (RFC 9111). The caller's `ttlMs` is how long a response stays fresh, and
 * server cache directives can only shorten it, unless the caller raises
 * `maxTtlMs`. A stale entry with an `ETag` or `Last-Modified` is kept for a
 * retention window and renewed by a matching 304; with `staleIfError`, a
 * stale entry is also kept to serve when the server fails.
 *
 * Works on any `CacheStore` and `BodyCodec` the host passes in, with no Node
 * APIs. The host derives the key, decides whether caching is enabled, and
 * records telemetry around these calls; `fetchWithCache` does all of it for
 * one request.
 */

import CachePolicy from "http-cache-semantics";
import type { BodyCodec } from "./body.js";
import type { CacheEntry, CacheStore } from "./store.js";

/**
 * How long a stale entry with a validator, or any entry with
 * `staleIfError`, is kept after it goes stale, unless the caller sets
 * `retainMs`. Bounded by the store's byte budget like any other entry.
 */
export const REVALIDATION_WINDOW_MS: number = 24 * 60 * 60 * 1000;

/**
 * Policy options for a cache scoped to one identity: keys already separate
 * users, so `private` responses are storable.
 */
const POLICY_OPTIONS: CachePolicy.Options = {
  shared: false,
  cacheHeuristic: 0.1,
};

/** Response headers kept for callers, such as `Link` for pagination. */
const PRESERVED_HEADERS = ["link"];

/** The validators a conditional request sends. */
const CONDITIONAL_HEADERS = ["if-none-match", "if-modified-since"];

const encoder = new TextEncoder();

/**
 * How long a cached response is fresh. Shared by lookups and stores, which
 * must agree for the same URL.
 */
export type FreshnessOptions = {
  /**
   * How long a response serves without asking the server. `0` revalidates
   * every read. Server cache directives (`max-age`, `no-cache`, `Expires`)
   * can shorten it.
   */
  ttlMs: number;
  /**
   * The longest freshness that server directives may give. Defaults to
   * `ttlMs`, so a server `max-age` never makes a read skip revalidation for
   * longer than the caller allows. Pass `Infinity` to let the server's
   * directives win.
   */
  maxTtlMs?: number;
  /**
   * How long an entry is kept after it goes stale, for revalidation and
   * `staleIfError`. Defaults to {@link REVALIDATION_WINDOW_MS}.
   */
  retainMs?: number;
  /**
   * Keep stale entries without a validator, and return them from
   * `lookupResponse` so the caller can serve one when the server fails.
   */
  staleIfError?: boolean;
};

/**
 * Result of a lookup that found a usable entry.
 *
 * - `hit`: the entry is fresh; serve `response`. `createdAt` is when the
 *   response was received, and `size` is the decoded body size in bytes.
 * - `stale`: the entry is stale. Send the request with `conditionalHeaders`
 *   (empty when the entry has no validator), then pass the network response
 *   to `revalidate`. On a matching 304 it renews the entry and returns the
 *   cached body; otherwise it returns `undefined` and the network response
 *   stands (or, for an unusable 304, the caller fetches again without the
 *   headers). With `staleIfError`, `serveStale` returns the cached body for
 *   a request that failed.
 */
export type CacheLookup =
  | { kind: "hit"; response: Response; createdAt: number; size: number }
  | {
      kind: "stale";
      conditionalHeaders: Record<string, string>;
      /** When the stale response was received or last revalidated. */
      createdAt: number;
      revalidate(response: Response): Promise<Response | undefined>;
      /** Only with `staleIfError`. `undefined` if the body cannot be read. */
      serveStale?: () => Promise<Response | undefined>;
    };

export type LookupOptions = FreshnessOptions & {
  store: CacheStore;
  codec: BodyCodec;
  /** From `buildCacheKey`, so the entry is scoped to the identity. */
  key: string;
  url: string;
  /** Headers of the new request, for `Vary` matching. */
  requestHeaders: Record<string, string>;
  /** Called when renewing a revalidated entry fails; the response stands. */
  onRenewError?: (error: unknown) => void;
};

export type StoreOptions = FreshnessOptions & {
  store: CacheStore;
  codec: BodyCodec;
  /** From `buildCacheKey` for the same identity, method, and URL. */
  key: string;
  /** Recorded on the entry for identity-scoped invalidation. */
  identity: string;
  url: string;
  /** Headers the request was sent with, for `Vary` matching. */
  requestHeaders: Record<string, string>;
  /** The response to cache; its body is consumed. */
  response: Response;
  /** Store only bodies that parse as JSON, and throw for any other. */
  requireJson?: boolean;
};

/** A GET request as `http-cache-semantics` reads it. */
type GetRequest = {
  url: string;
  method: "GET";
  headers: Record<string, string>;
};

/** Keep only the response headers callers need. */
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

/**
 * Request headers as the policy records them, with `authorization` replaced
 * by its SHA-256 digest. `CachePolicy#toObject()` keeps request headers when
 * the response has `Vary`, and a store must never hold the token. Lookup and
 * store derive the value the same way, so `Vary: Authorization` still tells
 * tokens apart.
 */
async function policyRequestHeaders(
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  // Lowercase names, as `http-cache-semantics` stores them and `Vary`
  // matching compares them.
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    result[name] =
      name === "authorization" && value ? await sha256Hex(value) : value;
  }
  return result;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

/**
 * Whether the server sent `Cache-Control` directives or `Expires`.
 * `timeToLive() === 0` alone is ambiguous: it means both "no headers" (use
 * the caller's TTL) and "max-age=0" (do not reuse).
 */
function hasServerCacheDirectives(policy: CachePolicy): boolean {
  const { rescc, resh } = policy.toObject();
  return Object.keys(rescc).length > 0 || resh["expires"] !== undefined;
}

/** Whether the stored response has an `ETag` or `Last-Modified`. */
function hasValidator(policy: CachePolicy): boolean {
  const headers = policy.responseHeaders();
  return (
    headers["etag"] !== undefined || headers["last-modified"] !== undefined
  );
}

/**
 * Whether the request has the headers the stored response varies on. A
 * response with `Vary: *` matches no request.
 */
function varyMatches(policy: CachePolicy, request: GetRequest): boolean {
  const { resh, reqh } = policy.toObject();
  const vary = resh["vary"];
  if (vary === undefined) {
    return true;
  }
  const stored = reqh ?? {};
  return String(vary)
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .every((name) => name !== "*" && stored[name] === request.headers[name]);
}

/**
 * Whether `entry` can be served without revalidation: within the caller's
 * TTL, and, when the server sent directives, within theirs too (capped at
 * `maxTtlMs`).
 */
function isEntryFresh(
  policy: CachePolicy,
  entry: CacheEntry,
  request: GetRequest,
  options: FreshnessOptions,
): boolean {
  const ageMs = Date.now() - entry.createdAt;
  if (!hasServerCacheDirectives(policy)) {
    return ageMs < options.ttlMs;
  }
  const maxTtlMs = options.maxTtlMs ?? options.ttlMs;
  return ageMs < maxTtlMs && policy.satisfiesWithoutRevalidation(request);
}

/**
 * How long a store keeps an entry: its freshness lifetime, plus the
 * retention window when it has a validator or the caller wants stale
 * entries for errors.
 */
function retentionMs(policy: CachePolicy, options: FreshnessOptions): number {
  const freshMs = hasServerCacheDirectives(policy)
    ? Math.min(policy.timeToLive(), options.maxTtlMs ?? options.ttlMs)
    : options.ttlMs;
  return hasValidator(policy) || options.staleIfError
    ? freshMs + (options.retainMs ?? REVALIDATION_WINDOW_MS)
    : freshMs;
}

/**
 * Headers for a response served from `entry`: the policy's computed headers,
 * with multiple values joined, plus the preserved headers it lacks.
 */
function buildResponseHeaders(
  policy: CachePolicy,
  entry: CacheEntry,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(policy.responseHeaders())) {
    if (value !== undefined) {
      result[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  for (const [name, value] of Object.entries(entry.headers)) {
    if (!(name in result)) {
      result[name] = value;
    }
  }
  return result;
}

/** Statuses whose `Response` must have a null body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * The response served from `entry` with a decoded body. TypeScript's DOM
 * `BodyInit` takes only `ArrayBuffer`-backed views; stored bodies never sit
 * on a `SharedArrayBuffer`.
 */
function cachedResponse(
  entry: CacheEntry,
  body: Uint8Array,
  headers: Record<string, string>,
): Response {
  return new Response(
    NULL_BODY_STATUSES.has(entry.status)
      ? null
      : (body as Uint8Array<ArrayBuffer>),
    { status: entry.status, headers },
  );
}

/** The validators to send for a stale entry; empty without one. */
function conditionalHeaders(
  policy: CachePolicy,
  request: GetRequest,
): Record<string, string> {
  const headers = policy.revalidationHeaders(request);
  const result: Record<string, string> = {};
  for (const name of CONDITIONAL_HEADERS) {
    const value = headers[name];
    if (typeof value === "string") {
      result[name] = value;
    }
  }
  return result;
}

/**
 * A `stale` lookup for an entry with a validator or with `staleIfError`, or
 * `undefined` for one that is of no use.
 */
function staleLookup(
  options: LookupOptions,
  entry: CacheEntry,
  policy: CachePolicy,
  request: GetRequest,
): CacheLookup | undefined {
  const validators = conditionalHeaders(policy, request);
  const revalidates = Object.keys(validators).length > 0;
  if (!revalidates && !options.staleIfError) {
    return;
  }
  const { store, codec, key, onRenewError } = options;

  async function decoded(
    responsePolicy: CachePolicy,
  ): Promise<Response | undefined> {
    const body = await codec.decode(entry.body);
    return body
      ? cachedResponse(entry, body, buildResponseHeaders(responsePolicy, entry))
      : undefined;
  }

  return {
    kind: "stale",
    conditionalHeaders: validators,
    createdAt: entry.createdAt,
    async revalidate(response) {
      if (!revalidates || response.status !== 304) {
        return;
      }
      const result = policy.revalidatedPolicy(request, {
        status: response.status,
        headers: headersToObject(response.headers),
      });
      // A 304 for a different or missing validator says nothing about
      // this entry, so its body cannot be trusted.
      if (result.modified || !result.matches) {
        return;
      }
      const cached = await decoded(result.policy);
      if (!cached) {
        return;
      }

      const renewed = {
        ...entry,
        policy: result.policy.toObject(),
        createdAt: Date.now(),
      };
      store
        .set(key, renewed, retentionMs(result.policy, options))
        .catch((error: unknown) => onRenewError?.(error));
      return cached;
    },
    ...(options.staleIfError
      ? { serveStale: async () => await decoded(policy) }
      : {}),
  };
}

/**
 * Look up a GET request: a fresh entry is a `hit`, and a stale one is
 * returned for conditional revalidation or, with `staleIfError`, for
 * serving on an error.
 *
 * @returns The lookup, or `undefined` on a miss: no entry, a request that
 *   differs in a header the entry varies on, a stale entry without a
 *   validator (and no `staleIfError`), or a body this runtime cannot decode
 * @throws When the stored policy or body is corrupt; the host may drop the
 *   entry and treat it as a miss
 */
export async function lookupResponse(
  options: LookupOptions,
): Promise<CacheLookup | undefined> {
  const { store, codec, key, url, requestHeaders } = options;
  const entry = await store.get(key);
  if (!entry) {
    return;
  }

  const policy = CachePolicy.fromObject(
    entry.policy as CachePolicy.CachePolicyObject,
  );
  const request: GetRequest = {
    url,
    method: "GET",
    headers: await policyRequestHeaders(requestHeaders),
  };
  // Another variant of the resource: neither fresh nor usable when stale.
  if (!varyMatches(policy, request)) {
    return;
  }
  if (!isEntryFresh(policy, entry, request, options)) {
    return staleLookup(options, entry, policy, request);
  }

  const body = await codec.decode(entry.body);
  if (!body) {
    return;
  }
  return {
    kind: "hit",
    response: cachedResponse(entry, body, buildResponseHeaders(policy, entry)),
    createdAt: entry.createdAt,
    size: body.byteLength,
  };
}

/**
 * Store a successful GET response when HTTP caching allows it: not for
 * `no-store` or a non-2xx status. The entry is kept for its freshness
 * lifetime, plus the retention window with a validator or `staleIfError`.
 *
 * @returns The stored (encoded) body size in bytes, or 0 when not stored
 * @throws With `requireJson`, when the body is not JSON
 */
export async function storeResponse(options: StoreOptions): Promise<number> {
  const { store, codec, key, identity, url, requestHeaders, response } =
    options;
  if (!response.ok) {
    discardBody(response);
    return 0;
  }

  const policy = new CachePolicy(
    {
      url,
      method: "GET",
      headers: await policyRequestHeaders(requestHeaders),
    },
    { status: response.status, headers: headersToObject(response.headers) },
    POLICY_OPTIONS,
  );
  const ttlMs = retentionMs(policy, options);
  if (!policy.storable() || !(ttlMs > 0)) {
    discardBody(response);
    return 0;
  }

  const raw = new Uint8Array(await response.arrayBuffer());
  if (options.requireJson) {
    // Throws for a body that is not JSON.
    JSON.parse(new TextDecoder().decode(raw));
  }
  const createdAt = Date.now();
  const body = await codec.encode(raw);
  await store.set(
    key,
    {
      url,
      identity,
      status: response.status,
      headers: pickHeaders(response.headers),
      body,
      policy: policy.toObject(),
      createdAt,
    },
    ttlMs,
  );
  return body.bytes.byteLength;
}

/**
 * Release a body the cache will not read, so a clone does not buffer the
 * whole response while the caller reads the original. Not awaited:
 * cancelling one branch of a tee settles only once the other is read.
 */
function discardBody(response: Response): void {
  if (response.body && !response.bodyUsed) {
    response.body.cancel().catch(() => undefined);
  }
}
