/**
 * Validated Authorization values for the selected Sentry credential.
 *
 * `@sentry/api/client` has the same token rules, but `sentry __complete`
 * loads this module on every TAB press and must not load the client barrel.
 * The property tests check that both implementations agree.
 */

import { MalformedAuthTokenError } from "./errors.js";

/** A valid bearer credential contains only visible ASCII bytes. */
const INVALID_TOKEN_CHARACTER_PATTERN = /[^\x21-\x7e]/;
// oxlint-disable-next-line no-control-regex -- copied ASCII controls are removable edge padding.
const TOKEN_PADDING_PATTERN = /[\s\x00-\x1f\x7f]/;

/** Strip padding at the edges without changing bytes within the token. */
export function trimAuthToken(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && TOKEN_PADDING_PATTERN.test(token.charAt(start))) {
    start += 1;
  }
  while (end > start && TOKEN_PADDING_PATTERN.test(token.charAt(end - 1))) {
    end -= 1;
  }
  return token.slice(start, end);
}

/** Trim padding and validate the credential selected for storage or a request. */
export function normalizeAuthToken(token: string): string {
  const normalized = trimAuthToken(token);
  if (!normalized || INVALID_TOKEN_CHARACTER_PATTERN.test(normalized)) {
    throw new MalformedAuthTokenError();
  }
  return normalized;
}

/** Normalize and validate a credential before constructing its Authorization value. */
export function formatAuthHeader(token: string): string {
  return `Bearer ${normalizeAuthToken(token)}`;
}
