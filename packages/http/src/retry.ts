/**
 * Retry policy for HTTP requests. Pure logic over standard Web APIs, so it
 * runs in Node, Cloudflare Workers, and browsers. `nextRetryDelayMs` decides
 * whether to retry and how long to wait; `fetchWithRetry` is a request loop
 * built on it for hosts that do not own one.
 */

/** Caps for one logical request. All delays are in milliseconds. */
export type RetryPolicy = {
  /** Retries after the first attempt. */
  maxRetries: number;
  /** First fallback backoff step; it doubles on each retry. */
  baseDelayMs: number;
  /** Longest single wait. A server delay above this is not waited for. */
  maxDelayMs: number;
  /** Longest total wait across every retry of the request. */
  maxTotalDelayMs: number;
};

/**
 * Which requests a failed status may replay.
 *
 * - `any`: the server rejects the request before running it, so replaying
 *   any method is safe, such as a rate limiter in front of the handler.
 * - `idempotent`: the handler may have run, so only GET, HEAD, and OPTIONS
 *   retry, unless the caller marks the request `idempotent`.
 */
export type RetryReplay = "any" | "idempotent";

/** Retried statuses and which requests each may replay. */
export type RetryableStatuses = ReadonlyMap<number, RetryReplay>;

type HeaderReader = Pick<Headers, "get">;

const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);

/**
 * The statuses retried when the caller does not pass its own. Other 5xx
 * codes (501, 505, ...) are deterministic and are not retried. A server
 * that rejects rate-limited requests before running them can map 429 to
 * `any`.
 */
export const DEFAULT_RETRYABLE_STATUSES: RetryableStatuses = new Map<
  number,
  RetryReplay
>([
  [429, "idempotent"],
  [500, "idempotent"],
  [502, "idempotent"],
  [503, "idempotent"],
  [504, "idempotent"],
]);

/** The response `Date` header truncates server time to whole seconds. */
const DATE_RESOLUTION_MS = 1000;

/**
 * Whether a request may be replayed after the server may have run it: a
 * transient 5xx, a network error, or a timeout. True for GET, HEAD, and
 * OPTIONS, or when the caller marks the request `idempotent`.
 */
export function isIdempotentRequest(
  method: string,
  idempotent = false,
): boolean {
  return idempotent || IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Whether this failed request may be sent again. With no status (a network
 * error or timeout), the server may have run it, so only idempotent
 * requests replay.
 */
function isRetryable(
  method: string,
  status: number | undefined,
  idempotent: boolean,
  statuses: RetryableStatuses,
): boolean {
  const replays = status === undefined ? "idempotent" : statuses.get(status);
  if (replays === undefined) {
    return false;
  }
  return replays === "any" || isIdempotentRequest(method, idempotent);
}

/**
 * Milliseconds the response's `Retry-After` (seconds or HTTP-date) asks the
 * client to wait, or undefined when it is missing or unusable.
 */
export function parseRetryAfterMs(
  headers: HeaderReader,
  now: number = Date.now(),
): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (!retryAfter) {
    return undefined;
  }
  if (/^\d+$/.test(retryAfter)) {
    return Number(retryAfter) * 1000;
  }
  const date = Date.parse(retryAfter);
  return Number.isNaN(date) ? undefined : serverDelayUntil(date, headers, now);
}

/**
 * Milliseconds until a server-clock `target` (epoch ms), such as a
 * rate-limit reset header. The local clock gives the finest estimate, but
 * it may be skewed. The response `Date` bounds the server's clock to
 * `[date, date + 1s)`, so the true delay lies in
 * `(target - date - 1s, target - date]`; the local estimate is clamped into
 * it.
 */
export function serverDelayUntil(
  target: number,
  headers: HeaderReader,
  now: number = Date.now(),
): number {
  let delay = target - now;
  const date = Date.parse(headers.get("date") ?? "");
  if (!Number.isNaN(date)) {
    const latest = target - date;
    delay = Math.min(Math.max(delay, latest - DATE_RESOLUTION_MS), latest);
  }
  return Math.max(0, delay);
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
  idempotent = false,
  status,
  serverDelayMs,
  attempt,
  waitedMs,
  retryableStatuses = DEFAULT_RETRYABLE_STATUSES,
  random = Math.random,
}: {
  policy: RetryPolicy;
  method: string;
  idempotent?: boolean;
  /** Failed response status, or undefined for a network error or timeout. */
  status: number | undefined;
  /** The delay the server asked for, such as from `parseRetryAfterMs`. */
  serverDelayMs: number | undefined;
  /** Retries already made for this request, starting at 0. */
  attempt: number;
  /** Total time already spent waiting for this request. */
  waitedMs: number;
  retryableStatuses?: RetryableStatuses;
  random?: () => number;
}): number | undefined {
  if (
    attempt >= policy.maxRetries ||
    !isRetryable(method, status, idempotent, retryableStatuses)
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
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the platform rejects with the signal's own abort reason, often a DOMException or a caller-chosen value, and callers check it verbatim
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the platform rejects with the signal's own abort reason, often a DOMException or a caller-chosen value, and callers check it verbatim
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** What `fetchWithRetry` reports before it waits for a retry. */
export type RetryAttempt = {
  /** Retries already made, starting at 0. */
  attempt: number;
  delayMs: number;
  /** The failed status, or undefined when `send` threw. */
  status: number | undefined;
  /** What `send` threw, when it threw. */
  error?: unknown;
};

export type RetryOptions = {
  policy: RetryPolicy;
  /** The request method, which decides what may replay. */
  method: string;
  /** Mark a write the server dedupes, so it replays like a GET. */
  idempotent?: boolean;
  /** Defaults to {@link DEFAULT_RETRYABLE_STATUSES}. */
  retryableStatuses?: RetryableStatuses;
  /**
   * The delay a failed response asks for. Defaults to `Retry-After`; pass
   * one to read a provider's rate-limit reset header too.
   */
  serverDelayMs?: (response: Response) => number | undefined;
  /**
   * Whether an error that `send` threw may be retried. Defaults to every
   * error; return false for one that will not change, such as a TLS
   * failure.
   */
  isRetryableError?: (error: unknown) => boolean;
  /** Stops waiting, and rejects with its reason. */
  signal?: AbortSignal;
  onRetry?: (retry: RetryAttempt) => void;
  random?: () => number;
};

/**
 * Send a request, and send it again after a retryable failure until the
 * policy stops. `send` must build a new request each time, since a request
 * body can be read only once.
 *
 * @returns The last response, which may be a failure the caller handles
 * @throws What the last `send` threw, or the signal's reason on abort
 */
export async function fetchWithRetry(
  send: (attempt: number) => Promise<Response>,
  options: RetryOptions,
): Promise<Response> {
  const { policy, method, idempotent, retryableStatuses, signal } = options;
  const serverDelayMs =
    options.serverDelayMs ??
    ((response: Response) => parseRetryAfterMs(response.headers));
  const decide = (
    status: number | undefined,
    delay: number | undefined,
    attempt: number,
    waitedMs: number,
  ): number | undefined =>
    nextRetryDelayMs({
      policy,
      method,
      status,
      serverDelayMs: delay,
      attempt,
      waitedMs,
      ...(idempotent === undefined ? {} : { idempotent }),
      ...(retryableStatuses === undefined ? {} : { retryableStatuses }),
      ...(options.random === undefined ? {} : { random: options.random }),
    });
  let waitedMs = 0;

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await send(attempt);
    } catch (error) {
      const delayMs =
        signal?.aborted || options.isRetryableError?.(error) === false
          ? undefined
          : decide(undefined, undefined, attempt, waitedMs);
      if (delayMs === undefined) {
        throw error;
      }
      options.onRetry?.({ attempt, delayMs, status: undefined, error });
      await sleep(delayMs, signal);
      waitedMs += delayMs;
      continue;
    }

    const delayMs = response.ok
      ? undefined
      : decide(response.status, serverDelayMs(response), attempt, waitedMs);
    if (delayMs === undefined) {
      return response;
    }
    response.body?.cancel().catch(() => undefined);
    options.onRetry?.({ attempt, delayMs, status: response.status });
    await sleep(delayMs, signal);
    waitedMs += delayMs;
  }
}
