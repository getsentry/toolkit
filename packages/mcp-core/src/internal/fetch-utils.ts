/**
 * Fetch with timeout using AbortController
 * @param url - The URL to fetch
 * @param options - Standard fetch options; `signal` cancels the request too
 * @param timeoutMs - Timeout in milliseconds (default: 30000)
 * @returns Promise<Response>
 * @throws Error if request times out
 * @throws The signal's reason when `options.signal` aborts
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: RequestInit = {},
  timeoutMs = 30000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal,
    });
    return response;
  } catch (error) {
    if (
      !options.signal?.aborted &&
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Wait `ms` milliseconds, or until `signal` aborts.
 * @throws The signal's reason when it aborts
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(signal?.reason);
    };
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry a function with exponential backoff
 * @param fn - The async function to retry
 * @param options - Retry options
 * @param options.maxRetries - Maximum number of retries (default: 3)
 * @param options.initialDelay - Initial delay in milliseconds (default: 1000)
 * @param options.shouldRetry - Predicate to determine if error should be retried (default: always retry)
 * @param options.signal - Cancels the retries; the signal's reason is thrown
 * @returns Promise with the function result
 * @throws The last error if all retries are exhausted
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  {
    maxRetries = 3,
    initialDelay = 1000,
    shouldRetry = () => true,
    signal,
  }: {
    maxRetries?: number;
    initialDelay?: number;
    shouldRetry?: (error: unknown) => boolean;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  let lastError: unknown;
  let delay = initialDelay;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // A cancelled call never retries.
      signal?.throwIfAborted();
      // Don't retry if we've exhausted attempts or if the error is non-retryable
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }

      // Wait before retrying with exponential backoff
      await sleep(delay, signal);
      delay = Math.min(delay * 2, 30000); // Cap at 30 seconds
    }
  }

  throw lastError;
}
