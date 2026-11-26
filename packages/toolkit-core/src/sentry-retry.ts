/**
 * Retries for Sentry API requests, shared by the CLI and MCP. `@sentry/api`
 * sends each request once; the host wraps its transport with these so the
 * retry policy stays the host's choice.
 */

import {
  type ApiTransport,
  parseRetryDelayMs,
  type RetryPolicy,
} from "@sentry/api/client";
import {
  type RetryableStatuses,
  type RetryingFetchOptions,
  withRetry,
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

/**
 * The transport's own retry policy: none, since {@link withSentryRetry}
 * retries around it. Remove once `@sentry/api` drops the required `retry`.
 */
export const TRANSPORT_SENDS_ONCE: RetryPolicy = {
  maxRetries: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxTotalDelayMs: 0,
};

/** Options for {@link withSentryRetry}; the statuses and delays are Sentry's. */
export type SentryRetryOptions = Omit<
  RetryingFetchOptions,
  "retryableStatuses" | "serverDelayMs"
>;

/**
 * Wrap `transport` so a failed Sentry API request is sent again, waiting
 * for `Retry-After` or Sentry's rate-limit reset when the response gives
 * one. Each attempt is a whole `transport.request` call, so it keeps the
 * transport's timeout, body handling, and credential refresh.
 */
export function withSentryRetry(
  transport: ApiTransport,
  options: SentryRetryOptions,
): ApiTransport {
  const request: ApiTransport["request"] = async (
    input,
    init,
    requestOptions,
  ) =>
    await withRetry(
      async (attemptInput, attemptInit) =>
        await transport.request(attemptInput, attemptInit, requestOptions),
      {
        ...options,
        idempotent:
          options.idempotent === true || requestOptions?.idempotent === true,
        retryableStatuses: SENTRY_RETRYABLE_STATUSES,
        serverDelayMs: (response) =>
          parseRetryDelayMs(response.status, response.headers),
      },
    )(input, init);
  return { request };
}
