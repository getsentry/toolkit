/**
 * Sentry token classification.
 *
 * Classifies a raw Bearer token by its well-known server-side prefix. The
 * prefixes come from `getsentry/sentry` `src/sentry/types/token.py` and the
 * `SENTRY_ORG_AUTH_TOKEN_PREFIX` constant in the backend authentication
 * module.
 *
 * This is used to short-circuit operations that are semantically
 * inapplicable to certain token types (e.g., `sentry auth whoami` on an
 * org auth token, which is not tied to a single user) without a round-trip
 * to the API.
 */

/** Sentry token kind inferred from the token's literal prefix. */
export type SentryTokenKind =
  /** `sntrys_...` — organization-scoped auth token, not tied to a user. */
  | "org-auth-token"
  /** `sntryu_...` — user-scoped personal access token. */
  | "user-auth-token"
  /** Any other shape: OAuth access tokens or legacy (pre-prefix) user tokens. */
  | "oauth-or-legacy";

/**
 * Classify a Sentry Bearer token by its prefix.
 *
 * Prefix comparison is case-sensitive — the server emits these prefixes in
 * lowercase only, so a mixed- or upper-case prefix is either user error
 * (should 401 on the server) or a legacy/OAuth token that doesn't follow
 * the prefix convention.
 */
export function classifySentryToken(token: string): SentryTokenKind {
  if (token.startsWith("sntrys_")) {
    return "org-auth-token";
  }
  if (token.startsWith("sntryu_")) {
    return "user-auth-token";
  }
  return "oauth-or-legacy";
}
