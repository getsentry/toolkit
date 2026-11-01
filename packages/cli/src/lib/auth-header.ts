/** Validated Authorization values for the selected Sentry credential. */

import {
  normalizeAuthToken as parseAuthToken,
  sentryBearerHeader,
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
  const header = sentryBearerHeader(token);
  if (header === null) {
    throw new MalformedAuthTokenError();
  }
  return header;
}

/**
 * Encode a credential for `process.env` storage.
 *
 * Environment blocks are NUL-terminated on every platform, so
 * `process.env.X = "pre\0post"` silently stores `"pre"` — truncating an
 * invalid credential into a *different*, possibly valid one before the shared
 * validation above ever sees it. NUL is the only byte env storage cannot
 * hold, so it is replaced with DEL (`\x7f`), which sits in the same classes
 * under the shared token rules: padding at the edges (so `trimAuthToken`
 * strips it identically) and never valid inside a credential (so
 * `normalizeAuthToken` rejects it identically). The credential therefore
 * reaches validation in full and yields the same accept/reject decision the
 * raw value would have.
 */
export function encodeAuthTokenForEnv(token: string): string {
  return token.replaceAll("\0", "\x7f");
}
