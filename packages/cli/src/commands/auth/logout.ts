/**
 * sentry auth logout [account]
 *
 * Remove stored authentication credentials.
 */

import type { SentryContext } from "../../context.js";
import {
  pointDefaultUrlAtAccount,
  resolveAccountSelector,
} from "../../lib/account-selection.js";
import { buildCommand } from "../../lib/command.js";
import {
  type AccountSummary,
  getAccountRow,
  listAccounts,
  toAccountSummary,
} from "../../lib/db/accounts.js";
import {
  clearAuth,
  ENV_SOURCE_PREFIX,
  getActiveAccountId,
  getActiveEnvVarName,
  getAuthConfig,
  removeAccount,
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
  /** Accounts that were removed */
  removed?: AccountSummary[];
  /** Account that is active after logout, if any remain */
  activeAccount?: AccountSummary;
};

type LogoutFlags = {
  readonly all: boolean;
  readonly json: boolean;
  readonly fields?: string[];
};

const COMMAND = "sentry auth logout";

/** Refuse when the only credential in play comes from an env var. */
function assertNotEnvOnly(): void {
  const auth = getAuthConfig();
  if (auth?.source.startsWith(ENV_SOURCE_PREFIX)) {
    const envVar = getActiveEnvVarName();
    throw new AuthError(
      "invalid",
      `Authentication is provided via ${envVar} environment variable. ` +
        `Unset ${envVar} to log out.`,
    );
  }
}

export const logoutCommand = buildCommand({
  auth: false,
  skipRcUrlCheck: true,
  docs: {
    brief: "Log out of Sentry",
    fullDescription:
      "Remove stored authentication credentials from the local database.\n\n" +
      "Without arguments, logs out of the active account; if other accounts are\n" +
      "stored, the most recently used one becomes active. Pass an account (email,\n" +
      "username, user ID, or account ID) to remove that one instead, or --all to\n" +
      "remove every stored account.",
  },
  output: { human: formatLogoutResult },
  parameters: {
    flags: {
      all: {
        kind: "boolean",
        brief: "Log out of every stored account",
        default: false,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "account",
          brief: "Email, username, user ID, or account ID to log out of",
          parse: String,
          optional: true,
        },
      ],
    },
  },
  async *func(this: SentryContext, flags: LogoutFlags, selector?: string) {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      assertNotEnvOnly();
      return yield new CommandOutput<LogoutResult>({
        loggedOut: false,
        message: "Not currently authenticated.",
      });
    }

    const configPath = getDbPath();

    if (flags.all) {
      await clearAuth();
      return yield new CommandOutput<LogoutResult>({
        loggedOut: true,
        configPath,
        removed: accounts,
      });
    }

    const target =
      selector === undefined
        ? accounts.find((a) => a.id === getActiveAccountId())
        : resolveAccountSelector(selector, COMMAND);
    if (!target) {
      return yield new CommandOutput<LogoutResult>({
        loggedOut: false,
        message:
          "No account is active. Run 'sentry auth list' and pass an account to log out of, or use --all.",
      });
    }

    const nextActiveId = await removeAccount(target.id, { promoteNext: true });
    const nextActiveRow = nextActiveId
      ? getAccountRow(nextActiveId)
      : undefined;
    const activeAccount = nextActiveRow
      ? toAccountSummary(nextActiveRow)
      : undefined;
    if (target.active && activeAccount) {
      pointDefaultUrlAtAccount(activeAccount.host);
    }

    return yield new CommandOutput<LogoutResult>({
      loggedOut: true,
      configPath,
      removed: [target],
      activeAccount,
    });
  },
});
