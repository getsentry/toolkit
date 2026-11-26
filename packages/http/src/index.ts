/**
 * HTTP response caching and retries over the Fetch API: freshness and
 * revalidation through `http-cache-semantics`, stale-if-error, identity-scoped
 * keys, a pluggable `CacheStore` with a byte-budgeted memory store, and
 * idempotency-aware retries with backoff and `Retry-After`. No Node APIs; the
 * compressing body codec is in `@sentry/http/codec`.
 */

export {
  type BodyCodec,
  type BodyEncoding,
  type EncodedBody,
  identityCodec,
} from "./body.js";
export { type CachedFetchOptions, fetchWithCache } from "./fetch.js";
export { buildCacheKey, normalizeUrl } from "./keys.js";
export {
  createMemoryStore,
  type MemoryStore,
  type MemoryStoreOptions,
} from "./memory-store.js";
export {
  type CacheLookup,
  type FreshnessOptions,
  type LookupOptions,
  lookupResponse,
  REVALIDATION_WINDOW_MS,
  type StoreOptions,
  storeResponse,
} from "./policy.js";
export {
  DEFAULT_RETRYABLE_STATUSES,
  fetchWithRetry,
  isIdempotentRequest,
  nextRetryDelayMs,
  parseRetryAfterMs,
  type RetryableStatuses,
  type RetryAttempt,
  type RetryOptions,
  type RetryPolicy,
  type RetryReplay,
  serverDelayUntil,
  sleep,
} from "./retry.js";
export type { CacheEntry, CacheStore } from "./store.js";
