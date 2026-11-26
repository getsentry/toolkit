/**
 * A fetch wrapper that retries, for hosts whose client takes or is a
 * `fetch`, such as `@sentry/api`'s transport.
 */

import {
  fetchWithRetry,
  parseRetryAfterMs,
  type RetryOptions,
} from "./retry.js";

/** The `fetch` signature this module wraps and returns. */
export type FetchLike = (
  input: Request | string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** The request {@link RetryingFetchOptions.isIdempotent} is asked about. */
export type RetryRequest = { method: string; url: string };

export type RetryingFetchOptions = Pick<
  RetryOptions,
  "policy" | "retryableStatuses" | "isRetryableError" | "onRetry" | "random"
> & {
  /**
   * The delay a failed response asks for. Defaults to `Retry-After`; pass
   * one to read a provider's rate-limit reset header too.
   */
  serverDelayMs?: (response: Response) => number | undefined;
  /** Every request through this fetch is safe to replay, such as a deduped upload. */
  idempotent?: boolean;
  /** Writes that are safe to replay, such as a catalog of idempotent operations. */
  isIdempotent?: (request: RetryRequest) => boolean;
};

/**
 * Wrap `fetch` so failed requests are sent again under `options.policy`.
 * A `Request` input is cloned for each attempt and a `ReadableStream` body
 * is read once into memory, so the request can be replayed. An abort from
 * the caller's signal stops at once.
 *
 * `fetch` can be a whole client request, such as `@sentry/api`'s
 * `transport.request`, so each attempt keeps that client's own timeout,
 * body handling, and credential refresh.
 *
 * @returns A fetch that resolves with the last response, which may be a
 *   failure the caller handles
 */
export function withRetry(
  fetch: FetchLike,
  options: RetryingFetchOptions,
): FetchLike {
  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const idempotent =
      options.idempotent === true ||
      options.isIdempotent?.({ method, url }) === true;
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const replay = await replayable(input, init);

    return await fetchWithRetry(
      async () => {
        const next = replay();
        return await fetch(next.input, next.init);
      },
      {
        policy: options.policy,
        method,
        idempotent,
        serverDelayMs:
          options.serverDelayMs ??
          ((response) => parseRetryAfterMs(response.headers)),
        ...(signal ? { signal } : {}),
        ...(options.isRetryableError
          ? { isRetryableError: options.isRetryableError }
          : {}),
        ...(options.retryableStatuses
          ? { retryableStatuses: options.retryableStatuses }
          : {}),
        ...(options.onRetry ? { onRetry: options.onRetry } : {}),
        ...(options.random ? { random: options.random } : {}),
      },
    );
  };
}

/**
 * A fresh `(input, init)` pair per attempt: `fetch` consumes a body, so a
 * retry would otherwise throw `Request body already used`. A `Request` is
 * cloned; a `ReadableStream` body, the only single-use body type, is read
 * once into a buffer. Other bodies pass through, which keeps the
 * `multipart/form-data` boundary `fetch` derives from `FormData`.
 */
async function replayable(
  input: Request | string | URL,
  init: RequestInit | undefined,
): Promise<
  () => { input: Request | string | URL; init: RequestInit | undefined }
> {
  if (input instanceof Request) {
    return () => ({ input: input.clone(), init });
  }
  const body = init?.body;
  if (body instanceof ReadableStream) {
    const snapshot = await new Response(body).arrayBuffer();
    return () => ({ input, init: { ...init, body: snapshot } });
  }
  return () => ({ input, init });
}
