/**
 * Retry policy for Sentry API requests. Pure logic over standard Web APIs, so
 * it runs in Node and Cloudflare Workers. Each product owns its request loop,
 * error classes, and caps; this module decides whether to retry and how long
 * to wait. A 401 credential refresh is not a retry here: the transport may
 * replay any method once after refreshing, because the endpoint never ran.
 */

/** Caps for one logical request. All delays are in milliseconds. */
export type RetryPolicy = {
  /** Retries after the first attempt. */
  maxRetries: number;
  retryableStatuses: readonly number[];
  /** First fallback backoff step; it doubles on each retry. */
  baseDelayMs: number;
  /** Longest single wait. A server delay above this is not waited for. */
  maxDelayMs: number;
  /** Longest total wait across every retry of the request. */
  maxTotalDelayMs: number;
};

type HeaderReader = Pick<Headers, "get">;

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The response `Date` header has one-second resolution, so smaller
 * disagreements with the local clock are noise, not skew.
 */
const CLOCK_SKEW_TOLERANCE_MS = 2000;

/**
 * Whether a failed request may be sent again. Writes are only retried when
 * the caller says replaying them is safe, such as a content-addressed upload.
 */
function isRetryableMethod(method: string, idempotent = false): boolean {
  return idempotent || IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Milliseconds the response asks the client to wait, or undefined when it
 * gives no usable delay. `Retry-After` (seconds or HTTP-date) wins; a proxy
 * may add it, but Sentry itself does not. Otherwise a 429 waits for
 * `X-Sentry-Rate-Limit-Reset`, the Unix second the next window starts. A
 * concurrency-limit 429 is not tied to the window, so it gets no delay here
 * and the caller falls back to backoff.
 */
export function parseRetryDelayMs(
  status: number,
  headers: HeaderReader,
  now: number = Date.now(),
): number | undefined {
  const reference = serverNow(headers, now);

  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) {
      return Number(retryAfter) * 1000;
    }
    const date = Date.parse(retryAfter);
    return Number.isNaN(date) ? undefined : Math.max(0, date - reference);
  }

  if (status !== 429 || !isWindowLimited(headers)) {
    return undefined;
  }
  const reset = Number(headers.get("x-sentry-rate-limit-reset"));
  if (!Number.isFinite(reset) || reset <= 0) {
    return undefined;
  }
  return Math.max(0, reset * 1000 - reference);
}

/**
 * Delay before the next retry, or undefined to stop and surface the error.
 * Stops when the method or status is not retryable, the retries are used up,
 * the server delay exceeds `maxDelayMs`, or the wait would exceed
 * `maxTotalDelayMs`.
 */
export function nextRetryDelayMs({
  policy,
  method,
  idempotent,
  status,
  serverDelayMs,
  attempt,
  waitedMs,
  random = Math.random,
}: {
  policy: RetryPolicy;
  method: string;
  idempotent?: boolean;
  status: number;
  /** From `parseRetryDelayMs` for the failed response. */
  serverDelayMs: number | undefined;
  /** Retries already made for this request, starting at 0. */
  attempt: number;
  /** Total time already spent waiting for this request. */
  waitedMs: number;
  random?: () => number;
}): number | undefined {
  if (
    attempt >= policy.maxRetries ||
    !isRetryableMethod(method, idempotent) ||
    !policy.retryableStatuses.includes(status)
  ) {
    return undefined;
  }

  let delayMs: number;
  if (serverDelayMs !== undefined) {
    if (serverDelayMs > policy.maxDelayMs) {
      return undefined;
    }
    // Spread clients that share a window so they don't all wake at its start.
    delayMs = serverDelayMs + random() * (policy.baseDelayMs / 2);
  } else {
    // Equal jitter: half the step is fixed, half is random.
    const step = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
    delayMs = step / 2 + random() * (step / 2);
  }

  return waitedMs + delayMs > policy.maxTotalDelayMs ? undefined : delayMs;
}

/** Wait `ms`, or reject with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The window reset is server time. Trust the local clock unless it disagrees
 * with the response `Date` by more than the header's resolution.
 */
function serverNow(headers: HeaderReader, now: number): number {
  const date = Date.parse(headers.get("date") ?? "");
  if (Number.isNaN(date) || Math.abs(now - date) <= CLOCK_SKEW_TOLERANCE_MS) {
    return now;
  }
  return date;
}

/**
 * Sentry sends `Remaining: 0` only when the fixed window is exhausted
 * (`above_rate_limit_check` in `sentry/ratelimits/utils.py`). Otherwise the
 * 429 came from the concurrency limit and the window reset is irrelevant.
 */
function isWindowLimited(headers: HeaderReader): boolean {
  return headers.get("x-sentry-rate-limit-remaining") === "0";
}
