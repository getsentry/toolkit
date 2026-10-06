/** Validated Authorization values for the selected Sentry credential. */

import {
  normalizeAuthToken as parseAuthToken,
  trimAuthToken as trimSharedAuthToken,
} from "@sentry/toolkit-core/auth-token";
import { MalformedAuthTokenError } from "./errors.js";

/** Preserve the CLI's existing public API while sharing the token rules. */
export function trimAuthToken(token: string): string {
  return trimSharedAuthToken(token);
}

/** Trim padding and validate the credential selected for storage or a request. */
export function normalizeAuthToken(token: string): string {
  const normalized = parseAuthToken(token);
  if (normalized === null) {
    throw new MalformedAuthTokenError();
  }
  return normalized;
}

/** Normalize and validate a credential before constructing its Authorization value. */
export function formatAuthHeader(token: string): string {
  return `Bearer ${normalizeAuthToken(token)}`;
}
