/**
 * sentry auth refresh
 *
 * Manually refresh the OAuth access token, or re-authenticate with
 * different scopes via the OAuth device flow (like `gh auth refresh -s`).
 *
 * When `--scope` or `--read-only` is passed, the command runs a new device
 * flow with the requested scopes instead of refreshing the existing token.
 * This bypasses the "already authenticated" gate in `auth login`, making
 * scope changes frictionless.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import {
  ENV_SOURCE_PREFIX,
  getActiveEnvVarName,
  getAuthConfig,
  refreshToken,
} from "../../lib/db/auth.js";
import { AuthError, ValidationError } from "../../lib/errors.js";
import { success } from "../../lib/formatters/colors.js";
import { formatDuration } from "../../lib/formatters/human.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { runInteractiveLogin } from "../../lib/interactive-login.js";
import { resolveOAuthScopeString } from "../../lib/oauth.js";

type RefreshFlags = {
  readonly json: boolean;
  readonly force: boolean;
  readonly "read-only": boolean;
  readonly scope?: readonly string[];
  readonly fields?: string[];
};

type RefreshOutput = {
  success: boolean;
  refreshed: boolean;
  message: string;
  expiresIn?: number;
  expiresAt?: string;
};

/** Whether the user asked for a scope change (--scope or --read-only). */
function hasScopeRequest(flags: RefreshFlags): boolean {
  return (
    flags["read-only"] || (flags.scope !== undefined && flags.scope.length > 0)
  );
}

/**
 * Resolve the OAuth scope string from the refresh flags.
 *
 * @throws {ValidationError} when `--read-only` and `--scope` are both set,
 *   or when `--scope` contains an invalid value.
 */
function resolveRefreshScope(flags: RefreshFlags): string {
  if (flags["read-only"] && flags.scope?.length) {
    throw new ValidationError(
      "--read-only and --scope cannot be used together. Use --read-only for the read-only subset, or --scope to list exact scopes.",
      "scope"
    );
  }
  if (flags.scope?.length) {
    const scopes = [...flags.scope].flatMap((v) => v.split(","));
    return resolveOAuthScopeString({ scopes });
  }
  return resolveOAuthScopeString({ readOnly: true });
}

/** Format refresh result for terminal output */
function formatRefreshResult(data: RefreshOutput): string {
  if (data.refreshed) {
    const validity =
      data.expiresIn === undefined
        ? ""
        : ` Access token valid for ${formatDuration(data.expiresIn)}.`;
    return `${success("✓")} ${data.message}.${validity}`;
  }
  const validity =
    data.expiresIn === undefined
      ? ""
      : ` for ${formatDuration(data.expiresIn)}`;
  return `${data.message}${validity}.\nUse --force to refresh anyway.`;
}

export const refreshCommand = buildCommand({
  auth: false,
  docs: {
    brief: "Refresh your OAuth access token",
    fullDescription: `
Manually refresh your OAuth access token using the stored refresh token.

Access token refresh normally happens automatically when making API requests.
Use this command to force an immediate refresh or to verify the refresh
mechanism is working correctly.

When --scope or --read-only is passed, re-authenticates via the OAuth
device flow with the requested scopes instead of refreshing the existing
token. This is the preferred way to add or change scopes on an existing
session (similar to \`gh auth refresh -s <scope>\`).

Examples:
  $ sentry auth refresh
  ✓ Access token refreshed successfully. Access token valid for 59 minutes.

  $ sentry auth refresh --force
  ✓ Access token refreshed successfully. Access token valid for 1 hour.

  $ sentry auth refresh --scope event:read --scope org:read
  Re-authenticating with scopes: event:read, org:read...

  $ sentry auth refresh --read-only
  Re-authenticating with read-only scopes...

  $ sentry auth refresh --json
  {"success":true,"refreshed":true,"expiresIn":3600,"expiresAt":"..."}
    `.trim(),
  },
  output: { human: formatRefreshResult },
  parameters: {
    flags: {
      force: {
        kind: "boolean",
        brief: "Force refresh even if the access token is still valid",
        default: false,
      },
      "read-only": {
        kind: "boolean",
        brief:
          "Re-authenticate with read-only OAuth scopes (project:read, org:read, event:read, member:read, team:read)",
        default: false,
      },
      scope: {
        kind: "parsed",
        parse: String,
        brief:
          "Re-authenticate with specific OAuth scopes (repeatable, comma-separated). " +
          "E.g. --scope project:read --scope org:read",
        variadic: true,
        optional: true,
      },
    },
    aliases: { s: "scope" },
  },
  async *func(this: SentryContext, flags: RefreshFlags) {
    // Env var tokens can't be refreshed or re-scoped via the CLI.
    const currentAuth = getAuthConfig();
    if (currentAuth?.source.startsWith(ENV_SOURCE_PREFIX)) {
      const envVar = getActiveEnvVarName();
      throw new AuthError(
        "invalid",
        "Cannot refresh an environment variable token.\n" +
          "Token refresh is only available for OAuth sessions.\n" +
          `Update ${envVar} to change your token.`
      );
    }

    // --scope / --read-only: re-run the device flow with new scopes.
    if (hasScopeRequest(flags)) {
      const scope = resolveRefreshScope(flags);

      const result = await runInteractiveLogin({ scope });
      if (!result) {
        process.exitCode = 1;
        return;
      }

      const payload: RefreshOutput = {
        success: true,
        refreshed: true,
        message: "Re-authenticated with updated scopes",
        expiresIn: result.expiresIn,
        expiresAt: result.expiresIn
          ? new Date(Date.now() + result.expiresIn * 1000).toISOString()
          : undefined,
      };
      return yield new CommandOutput(payload);
    }

    // Standard token refresh path (no scope change).
    const auth = await getAuthConfig();
    if (!auth?.refreshToken && auth?.token) {
      throw new AuthError(
        "invalid",
        "No refresh token available. You may be using a manual API token.\n" +
          "Run 'sentry auth login' to authenticate with OAuth and enable auto-refresh."
      );
    }

    const result = await refreshToken({ force: flags.force });

    const payload: RefreshOutput = {
      success: true,
      refreshed: result.refreshed,
      message: result.refreshed
        ? "Access token refreshed successfully"
        : "Access token is still valid",
      expiresIn: result.expiresIn,
      expiresAt: result.expiresAt
        ? new Date(result.expiresAt).toISOString()
        : undefined,
    };

    return yield new CommandOutput(payload);
  },
});
