/** Validated Authorization values for the selected Sentry credential. */

import { MalformedAuthTokenError } from "./errors.js";

/** Bearer tokens are opaque, but cannot contain whitespace or non-ASCII bytes. */
const INVALID_TOKEN_CHARACTER_PATTERN = /[^\x21-\x7e]/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: pasted ASCII controls are the padding this rule removes.
const TOKEN_PADDING_PATTERN = /[\s\x00-\x1f\x7f]/;

/** Remove surrounding whitespace and ASCII controls without validating a candidate. */
export function trimAuthToken(token: string): string {
  // Scan only the edges; a trailing regex can backtrack over long internal runs.
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
