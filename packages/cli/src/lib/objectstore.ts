/**
 * Objectstore uploads for `snapshots upload`.
 *
 * The protocol client (batched HEADs and inserts, concurrency limits, key
 * encoding) lives in `@sentry/api/client`. This module adapts it to the CLI:
 * files are read from disk only when their request starts, requests go
 * through {@link customFetch} so custom CAs apply, and failures become CLI
 * {@link ApiError}s.
 *
 * Requests go over HTTP/1.1 (see http1-dispatcher.ts): on HTTP/2 the parallel
 * uploads share one connection, and Sentry's edge resets all but a couple of
 * them with `ENHANCE_YOUR_CALM`, as it did for chunk uploads (#2201).
 */

import { readFile, stat } from "node:fs/promises";
import {
  findExistingObjects as findExisting,
  type ObjectstoreConfig,
  ObjectstoreError,
  putObjects as putShared,
} from "@sentry/api/client";
import { customFetch } from "./custom-ca.js";
import { ApiError, isNetworkError } from "./errors.js";
import {
  createHttp1Dispatcher,
  destroyHttp1Dispatcher,
} from "./http1-dispatcher.js";

export type { ObjectstoreConfig };

/** A file to upload under an object key. */
export type ObjectUpload = { key: string; path: string };

type Options = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
};

/**
 * Run `work` with a fetch that sends every request over one HTTP/1.1
 * dispatcher, destroyed afterwards, and rethrow failures as CLI
 * {@link ApiError}s: an {@link ObjectstoreError} with its status, and a network
 * failure (`TypeError: fetch failed`) with its cause, which undici otherwise
 * hides.
 */
async function withCliErrors<T>(
  work: (options: Options) => Promise<T>,
): Promise<T> {
  const dispatcher = createHttp1Dispatcher();
  const options: Options = {
    fetch: (input, init) =>
      customFetch(input, { ...init, ...(dispatcher && { dispatcher }) }),
  };
  try {
    return await work(options);
  } catch (error) {
    if (isNetworkError(error)) {
      const cause = (error as Error).cause;
      const cliError = new ApiError(
        "Objectstore request failed",
        0,
        cause instanceof Error ? cause.message : String(error),
      );
      cliError.cause = error;
      throw cliError;
    }
    if (error instanceof ObjectstoreError) {
      const cliError = new ApiError(
        error.message,
        error.status ?? 0,
        error.detail,
        error.url,
      );
      cliError.cause = error;
      throw cliError;
    }
    throw error;
  } finally {
    await destroyHttp1Dispatcher(dispatcher);
  }
}

/**
 * Find which keys already exist.
 *
 * @returns The subset of `keys` that exist.
 * @throws {ApiError} On a failed batch, or any HEAD result other than 2xx/404.
 */
export function findExistingObjects(
  config: ObjectstoreConfig,
  keys: string[],
): Promise<Set<string>> {
  return withCliErrors((options) => findExisting(config, keys, options));
}

/**
 * Upload files as objects. Each file is read only when its request starts.
 *
 * @throws {ApiError} On a failed batch, or any failed insert.
 */
export async function putObjects(
  config: ObjectstoreConfig,
  uploads: ObjectUpload[],
): Promise<void> {
  const sized = await Promise.all(
    uploads.map(async ({ key, path }) => ({
      key,
      size: (await stat(path)).size,
      read: () => readFile(path),
    })),
  );
  await withCliErrors((options) => putShared(config, sized, options));
}
