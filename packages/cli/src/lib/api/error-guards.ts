/**
 * Reusable tests for Sentry API client errors.
 */

import { ApiError } from "../errors.js";

/** True if the error is a Sentry 404 (resource missing for this id/path). */
export function isNotFoundApiError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}
