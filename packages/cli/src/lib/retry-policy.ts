/**
 * Retry policy for Sentry API requests.
 *
 * Decides whether a failed request may be replayed automatically and how
 * long to wait first. Kept pure (no CLI imports, no I/O) so it can be swapped
 * for the shared toolkit-core policy without touching callers.
 *
 * Only safe methods (RFC 9110 §9.2.1) are replayed by default. A transient status, a
 * network error, or a timeout after a POST does not tell us whether the
 * server already applied it, so replaying could duplicate the write.
 * PUT and DELETE are excluded too: Sentry uses PUT for partial updates with
 * side effects (issue merges, activity, notifications), and a replayed
 * DELETE turns a successful delete into a 404. Writes Sentry marks
 * idempotent (`x-sentry-idempotent`, see idempotent-operations.ts) replay,
 * and callers that know an unmarked write is safe to replay opt in per
 * request.
 *
 * A 429 is the exception and retries for any method: Sentry's rate-limit
 * middleware rejects the request before the view runs, so nothing was
 * applied.
 */

/**
 * HTTP statuses that indicate a transient failure worth retrying. HTTP has no
 * normative "retryable" list; this matches common client defaults (undici's
 * RetryAgent, ky) plus 408. Not a blanket 5xx: 501, 505 and similar are
 * deterministic.
 */
const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

/**
 * RFC 9110 §9.2.1 safe methods (TRACE omitted, the CLI never sends it).
 * Deliberately narrower than the §9.2.2 idempotent set, which also includes
 * PUT and DELETE; see the module comment for why Sentry's aren't safe to
 * replay.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/** First fallback backoff step; doubles per attempt up to the cap. */
const BASE_BACKOFF_MS = 1000;

/**
 * Whether a request may be replayed after a transient status, network
 * error, or timeout.
 *
 * @param method - HTTP method (any case)
 * @param idempotent - Caller asserts the request is safe to replay
 */
export function isRetryableMethod(method: string, idempotent = false): boolean {
  return idempotent || SAFE_METHODS.has(method.toUpperCase());
}

/**
 * Jittered exponential backoff: a random delay in the upper half of
 * `min(1s * 2^attempt, maxDelayMs)`, so parallel requests spread out
 * without retrying sooner than half the nominal step.
 */
export function backoffDelayMs(
  attempt: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, maxDelayMs);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

function parseRetryAfterMs(value: string, referenceMs: number): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  return Date.parse(trimmed) - referenceMs;
}

/**
 * Delay requested by the server before retrying, in milliseconds.
 *
 * Reads `Retry-After` (delta seconds or HTTP date) on any status, and on 429
 * also `X-Sentry-Rate-Limit-Reset` (Unix seconds when the window resets).
 * The reset header is ignored when `X-Sentry-Rate-Limit-Remaining` is
 * non-zero: that 429 came from the concurrency limit, where the window reset
 * is unrelated and jittered backoff is the right wait.
 *
 * Absolute times are measured against the response `Date` header when
 * present, so a skewed local clock cannot turn a 1s window into a long wait
 * or an immediate retry. Times already in the past are dropped.
 *
 * @returns The longest requested wait, or undefined when the server gave
 *   no usable hint
 */
export function serverRetryDelayMs(
  status: number,
  headers: Headers,
  nowMs: number,
): number | undefined {
  const serverDate = Date.parse(headers.get("date") ?? "");
  const referenceMs = Number.isNaN(serverDate) ? nowMs : serverDate;
  const candidates: number[] = [];

  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    candidates.push(parseRetryAfterMs(retryAfter, referenceMs));
  }

  const remaining = headers.get("x-sentry-rate-limit-remaining");
  const reset = headers.get("x-sentry-rate-limit-reset");
  if (
    status === 429 &&
    reset &&
    (remaining === null || Number(remaining) <= 0)
  ) {
    candidates.push(Number(reset) * 1000 - referenceMs);
  }

  const valid = candidates.filter((ms) => Number.isFinite(ms) && ms >= 0);
  return valid.length > 0 ? Math.max(...valid) : undefined;
}

/** Outcome of {@link decideStatusRetry}. */
export type RetryDecision =
  | { retry: true; delayMs: number }
  | {
      retry: false;
      /** Server-requested wait, when known; tells the user when to retry. */
      retryAfterMs?: number;
    };

/**
 * Decide whether to retry a response with the given status.
 *
 * Retries retryable statuses while attempts remain and the server-requested
 * wait fits within `maxDelayMs`. A 429 retries for any method; other
 * statuses only when `methodRetryable`. Without a server hint, waits a
 * jittered exponential backoff.
 */
export function decideStatusRetry(params: {
  status: number;
  headers: Headers;
  methodRetryable: boolean;
  attempt: number;
  maxRetries: number;
  maxDelayMs: number;
  nowMs: number;
  random?: () => number;
}): RetryDecision {
  const { status, headers, methodRetryable, attempt, maxRetries, maxDelayMs } =
    params;
  if (!RETRYABLE_STATUS_CODES.has(status)) {
    return { retry: false };
  }
  const serverDelay = serverRetryDelayMs(status, headers, params.nowMs);
  if (
    (!methodRetryable && status !== 429) ||
    attempt >= maxRetries ||
    (serverDelay !== undefined && serverDelay > maxDelayMs)
  ) {
    return { retry: false, retryAfterMs: serverDelay };
  }
  return {
    retry: true,
    delayMs: serverDelay ?? backoffDelayMs(attempt, maxDelayMs, params.random),
  };
}
