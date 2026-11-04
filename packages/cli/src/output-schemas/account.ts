/**
 * Stored account output schema.
 */

import {
  boolean,
  description,
  number,
  object,
  optional,
  pipe,
  string,
} from "valibot";

/**
 * Public, secret-free view of a stored account, and the JSON output of
 * `sentry auth list` (one per account).
 */
export const AccountSummarySchema = object({
  id: pipe(string(), description("Account ID")),
  active: pipe(boolean(), description("Whether commands use this account")),
  host: optional(pipe(string(), description("Sentry server URL"))),
  userId: optional(pipe(string(), description("User ID"))),
  email: optional(pipe(string(), description("User email"))),
  username: optional(pipe(string(), description("Username"))),
  name: optional(pipe(string(), description("User display name"))),
  /** Whether the stored credential can still be used (or refreshed). */
  usable: pipe(
    boolean(),
    description("Whether the credential can still be used or refreshed"),
  ),
  expiresAt: optional(
    pipe(number(), description("Token expiry (Unix milliseconds)")),
  ),
  /**
   * Set for the virtual account of an env token (`SENTRY_AUTH_TOKEN` or
   * `SENTRY_TOKEN`), which is never stored: the variable providing it.
   */
  envVar: optional(
    pipe(string(), description("Env var providing the token, if not stored")),
  ),
});
