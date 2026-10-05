/**
 * sentry auth logout
 *
 * Clear stored authentication credentials.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import {
  clearAuth,
  ENV_SOURCE_PREFIX,
  getActiveEnvVarName,
  getAuthConfig,
  isAuthenticated,
} from "../../lib/db/auth.js";
import { getDbPath } from "../../lib/db/index.js";
import { AuthError } from "../../lib/errors.js";
import { formatLogoutResult } from "../../lib/formatters/human.js";
import { CommandOutput } from "../../lib/formatters/output.js";

/** Structured result of the logout operation */
export type LogoutResult = {
  /** Whether logout actually cleared credentials */
  loggedOut: boolean;
  /** Informational message when no action was taken */
  message?: string;
  /** Path where credentials were stored (when loggedOut is true) */
  configPath?: string;
};

export const logoutCommand = buildCommand({
  auth: false,
  skipRcUrlCheck: true,
  docs: {
    brief: "Log out of Sentry",
    fullDescription:
      "Remove stored authentication credentials from the local database.",
  },
  output: { human: formatLogoutResult },
  parameters: {
    flags: {},
  },
  async *func(this: SentryContext) {
    if (!isAuthenticated()) {
      return yield new CommandOutput({
        loggedOut: false,
        message: "Not currently authenticated.",
      });
    }

    const auth = getAuthConfig();
    if (auth?.source.startsWith(ENV_SOURCE_PREFIX)) {
      const envVar = getActiveEnvVarName();
      throw new AuthError(
        "invalid",
        `Authentication is provided via ${envVar} environment variable. ` +
          `Unset ${envVar} to log out.`
      );
    }

    const configPath = getDbPath();
    await clearAuth();

    return yield new CommandOutput({
      loggedOut: true,
      configPath,
    });
  },
});
