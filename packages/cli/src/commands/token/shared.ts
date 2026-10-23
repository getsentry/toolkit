/**
 * Shared scope handling for `sentry token` commands.
 *
 * Sentry only lets OAuth application tokens (a `sentry auth login` grant)
 * manage org auth tokens, and only when the grant includes `org:tokens`.
 * That scope isn't in the CLI's default login scopes, so each command asks
 * for it (plus whatever the endpoint needs) on first use.
 */

import { ApiError, AuthError, ContextError } from "../../lib/errors.js";
import { runInteractiveLogin } from "../../lib/interactive-login.js";
import { ensureScopesForAction } from "../../lib/scope-recovery.js";

/** Org slug: lowercase alphanumeric and hyphens, no leading/trailing hyphen. */
const ORG_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Consent scope Sentry requires for every org auth token request. */
const TOKEN_MANAGEMENT_SCOPE = "org:tokens";

/** Scopes for `token list`. */
export const LIST_SCOPES = [TOKEN_MANAGEMENT_SCOPE, "org:read"] as const;

/**
 * Scopes for `token create`. New tokens get `org:ci`, and an OAuth caller can
 * only mint scopes it holds itself.
 */
export const CREATE_SCOPES = [
  TOKEN_MANAGEMENT_SCOPE,
  "org:read",
  "org:ci",
] as const;

/** Scopes for `token delete`, which also lists tokens to confirm by name. */
export const DELETE_SCOPES = [
  TOKEN_MANAGEMENT_SCOPE,
  "org:read",
  "org:write",
] as const;

/**
 * Make sure the stored login can run a token command, re-authorizing it if
 * it lacks `required`.
 *
 * @param required - Scopes the command needs
 * @param action - Human description for the prompt, e.g. "Creating an org auth token"
 * @returns `true` when the login lacks `required` but this run can't
 *   re-authorize it (no interactive terminal, or `--yes`/`--json`); pass it to
 *   {@link explainTokenForbidden}
 * @throws {AuthError} When the user didn't complete the authorization
 */
export async function ensureTokenScopes(
  required: readonly string[],
  action: string,
): Promise<boolean> {
  const elevation = await ensureScopesForAction(
    required,
    action,
    runInteractiveLogin,
  );
  if (elevation === "declined") {
    throw new AuthError(
      "invalid",
      `Authorization was not completed, so the CLI can't manage org auth tokens.\n  ` +
        `If Sentry reported an unknown scope, your Sentry server doesn't support ${TOKEN_MANAGEMENT_SCOPE} yet.`,
      { skipAutoAuth: true },
    );
  }
  return elevation === "unavailable";
}

/**
 * Explain a 403 from a token endpoint. Sentry's body doesn't say whether the
 * scope, the auth method, or the user's org role is what's missing.
 *
 * @param error - Error thrown by the API call
 * @param required - Scopes the command needs
 * @param scopeMissing - The stored login lacks `required` and couldn't be
 *   re-authorized in this run (no interactive terminal, or `--yes`/`--json`/`--dry-run`,
 *   which must never block on the authorization flow)
 */
export function explainTokenForbidden(
  error: unknown,
  required: readonly string[],
  scopeMissing: boolean,
): unknown {
  if (!(error instanceof ApiError && error.status === 403)) {
    return error;
  }
  const scopes = required.join(", ");
  const detail = scopeMissing
    ? `Your saved login doesn't include ${scopes}. Re-authorization needs an interactive terminal and is skipped with --yes, --json, or --dry-run.\n  ` +
      "Run this command once in a terminal without --yes, --json, or --dry-run to re-authorize."
    : "Org auth tokens can only be managed with a CLI login from 'sentry auth login'. " +
      "Personal tokens, org auth tokens, and SENTRY_AUTH_TOKEN can't manage them.\n  " +
      `The login also needs ${scopes}, and your org role must allow it.`;
  return new ApiError(
    "Not allowed to manage org auth tokens",
    403,
    detail,
    error.endpoint,
  );
}

/**
 * Parse `[<org>/]<value>`.
 *
 * Splits on the first `/` when the part before it looks like an org slug, so
 * a token name can contain `/` when the org is given explicitly.
 *
 * @param arg - Raw positional, e.g. `my-org/github-actions`
 * @param label - What the value is, for the error, e.g. "Token name"
 * @param usageHint - Usage line for the error
 * @throws {ContextError} When the value is empty
 */
export function parseOrgScopedArg(
  arg: string | undefined,
  label: string,
  usageHint: string,
): { value: string; orgSlug?: string } {
  const trimmed = arg?.trim() ?? "";
  const slash = trimmed.indexOf("/");
  const prefix = slash > 0 ? trimmed.slice(0, slash) : "";
  const parsed = ORG_SLUG_RE.test(prefix)
    ? { orgSlug: prefix, value: trimmed.slice(slash + 1).trim() }
    : { value: trimmed };
  if (!parsed.value) {
    throw new ContextError(label, usageHint, []);
  }
  return parsed;
}
