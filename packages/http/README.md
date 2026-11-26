# @sentry/http

HTTP response caching, body compression, and retries over the Fetch API. It
runs in Node 22+, Cloudflare Workers, and browsers. The cache backend is yours:
implement `CacheStore` over Redis, SQLite, files, or R2, or use the in-memory
store that ships with the package.

```sh
npm install @sentry/http
```

## Read through the cache

`fetchWithCache` sends one GET through the cache. A fresh entry serves with no
request. A stale entry is revalidated with its `ETag` or `Last-Modified`, and a
`304 Not Modified` renews it. A 2xx response is stored. A 403, 404, or other
client error drops the entry.

```ts
import { createMemoryStore, fetchWithCache } from "@sentry/http";
import { createBodyCodec } from "@sentry/http/codec";

const store = createMemoryStore({ maxBytes: 16 * 1024 * 1024 });
const codec = createBodyCodec();

const response = await fetchWithCache({
  store,
  codec,
  // A stable hash of who is asking, never a raw token.
  identity: tokenFingerprint,
  url,
  ttlMs: 60_000,
  staleIfError: true,
  onStale: (createdAt) => console.warn(`served data from ${createdAt}`),
  send: (validators) => fetch(url, { headers: { ...headers, ...validators } }),
});
```

### Freshness

- `ttlMs` is how long a response serves without a request. `0` revalidates
  every read.
- Server cache headers (`Cache-Control`, `Expires`) can only shorten `ttlMs`,
  never extend it, so a server `max-age` cannot make a read skip revalidation
  longer than you allow. Set `maxTtlMs` to let the server's headers give more,
  such as `Infinity` to follow them.
- A stale entry with a validator stays in the store for `retainMs` (24 hours by
  default) so it can be revalidated.
- With `staleIfError`, a stale entry also stays without a validator. When `send`
  throws, or the server answers 429 or 5xx, the stale entry is served and
  `onStale` gets the time it was stored.

A cache failure, such as a store that is down or an entry that does not decode,
is a miss. It never fails the request; `onCacheError` reports it.

### Keys

`buildCacheKey(method, url, identity)` is the hex HMAC-SHA256 of the method
and the URL, with query parameters sorted, keyed by `identity`. An entry of one
identity never serves another. Pass your own `key` to `fetchWithCache` to add
request parts that change the response, such as `Accept`.

## Bring your own store

```ts
import type { CacheEntry, CacheStore } from "@sentry/http";

const store: CacheStore = {
  async get(key) {
    /* the entry, or undefined if missing or expired */
  },
  async set(key, entry: CacheEntry, ttlMs) {
    /* keep it for ttlMs; drop the old entry if this one is over your limits */
  },
  async delete(key) {},
  async deleteMatching(identity, urlPrefix) {
    /* remove identity's entries whose url starts with urlPrefix */
  },
};
```

`ttlMs` is how long to keep the entry, not how long it is fresh. Each store
enforces its own byte limits. `entry.body.bytes` is already encoded by the
codec; a store that keeps JSON can save it as base64. `entry.policy` is the
serialized cache policy: store it as is.

`createMemoryStore()` keeps entries in a byte-budgeted LRU map (24 MiB by
default, 1 MiB per stored body).

## Body codec

`@sentry/http/codec` compresses bodies with zstd level 3, or brotli where the
runtime has no zstd (Node before 22.15). Bodies under 256 bytes stay
uncompressed. Decompression never goes past the size recorded at encode time,
and an entry the runtime cannot decode is a miss. It needs `node:zlib`, which
Cloudflare Workers have with `nodejs_compat`. Without it, use `identityCodec`.

## Lower-level policy

`lookupResponse` and `storeResponse` are the steps `fetchWithCache` uses, for
hosts that own their request loop. `lookupResponse` returns a `hit` to serve, a
`stale` entry with the `conditionalHeaders` to send and a `revalidate` for the
response, or `undefined` for a miss.

## Retries

`fetchWithRetry` sends a request again after a retryable failure:

```ts
import { fetchWithRetry } from "@sentry/http";

const response = await fetchWithRetry(() => fetch(url, { method: "POST" }), {
  method: "POST",
  policy: {
    maxRetries: 2,
    baseDelayMs: 250,
    maxDelayMs: 5_000,
    maxTotalDelayMs: 10_000,
  },
});
```

- It waits for `Retry-After` when the server sends one, otherwise for an
  exponential backoff with jitter. It stops when a wait exceeds `maxDelayMs`
  or the total would exceed `maxTotalDelayMs`.
- 429, 500, 502, 503, and 504 retry, and so do errors that `send` throws, but
  only for GET, HEAD, and OPTIONS. Mark a write the server dedupes
  `idempotent: true` to replay it too. A server that rejects rate-limited
  requests before it runs them can pass `retryableStatuses` with 429 mapped to
  `"any"`.
- `serverDelayMs` reads a provider's own rate-limit header; `serverDelayUntil`
  turns a reset time into a delay, corrected by the response `Date`.

`nextRetryDelayMs` is the decision on its own, for hosts with their own loop.

## License

[FSL-1.1-Apache-2.0](LICENSE.md)
