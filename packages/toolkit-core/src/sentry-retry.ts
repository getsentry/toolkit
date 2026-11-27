/**
 * Retries for Sentry API requests, shared by the CLI and MCP. `@sentry/api`
 * sends each request once unless the host passes a `retry` hook; this
 * builds that hook on `@sentry/http`, so the retry policy stays the host's
 * choice.
 */

import {
  parseRetryDelayMs,
  type RetryRequest,
  type TransportRetry,
} from "@sentry/api/client";
import {
  fetchWithRetry,
  type RetryableStatuses,
  type RetryAttempt,
  type RetryOptions,
} from "@sentry/http";

/**
 * Sentry's retried statuses. Its `RatelimitMiddleware` rejects a 429 in
 * `process_request`, before the view runs (`sentry/middleware/ratelimit.py`),
 * so a 429 replays any method. The handler may have run for a 5xx, so only
 * idempotent requests replay. Other 5xx codes (501, 505, ...) are
 * deterministic and are not retried.
 */
export const SENTRY_RETRYABLE_STATUSES: RetryableStatuses = new Map([
  [429, "any"],
  [500, "idempotent"],
  [502, "idempotent"],
  [503, "idempotent"],
  [504, "idempotent"],
]);

/** Options for {@link sentryRetry}; the statuses and delays are Sentry's. */
export type SentryRetryOptions = Pick<
  RetryOptions,
  "policy" | "isRetryableError"
> & {
  onRetry?: (retry: RetryAttempt, request: RetryRequest) => void;
};

/**
 * The transport's `retry` hook: send a failed Sentry API request again,
 * waiting for `Retry-After` or Sentry's rate-limit reset when the response
 * gives one. The transport looks up the cache and the credential once per
 * request; each attempt keeps its timeout, body handling, and 401 refresh.
 */
export function sentryRetry({
  onRetry,
  ...options
}: SentryRetryOptions): TransportRetry {
  return async (attempt, request) =>
    await fetchWithRetry(attempt, {
      ...options,
      method: request.method,
      idempotent: request.idempotent,
      ...(request.signal ? { signal: request.signal } : {}),
      retryableStatuses: SENTRY_RETRYABLE_STATUSES,
      serverDelayMs: (response) =>
        parseRetryDelayMs(response.status, response.headers),
      ...(onRetry ? { onRetry: (retry) => onRetry(retry, request) } : {}),
    });
}
