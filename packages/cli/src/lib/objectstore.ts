/**
 * Objectstore uploads for `snapshots upload`.
 *
 * The protocol client (batched HEADs and inserts, concurrency limits, key
 * encoding) lives in `@sentry/api/client`. This module adapts it to the CLI:
 * files are read from disk only when their request starts, requests go
 * through {@link customFetch} so custom CAs apply, and failures become CLI
 * {@link ApiError}s.
 */

import { readFile, stat } from "node:fs/promises";
import {
  findExistingObjects as findExisting,
  type ObjectstoreConfig,
  ObjectstoreError,
  putObjects as putShared,
} from "@sentry/api/client";
import { customFetch } from "./custom-ca.js";
import { ApiError } from "./errors.js";

export type { ObjectstoreConfig };

/** A file to upload under an object key. */
export type ObjectUpload = { key: string; path: string };

const options = { fetch: customFetch };

/** Rethrow an {@link ObjectstoreError} as a CLI {@link ApiError}. */
async function withCliErrors<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
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
  return withCliErrors(findExisting(config, keys, options));
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
  await withCliErrors(putShared(config, sized, options));
}
