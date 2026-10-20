/**
 * sentry auth logout [account...|all]
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
  isAccountOnServer,
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
import { parseLoginUrl } from "./login.js";

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
  /** Set when `all` was requested */
  all?: boolean;
};

type LogoutFlags = {
  readonly url?: string;
  readonly json: boolean;
  readonly fields?: string[];
};

const COMMAND = "sentry auth logout";

/** Selector that logs out of every stored account. */
const ALL_ACCOUNTS = "all";

/** Split `a,b c` style arguments into individual, non-empty selectors. */
export function parseLogoutSelectors(args: readonly string[]): string[] {
  return args
    .flatMap((arg) => arg.split(","))
    .map((selector) => selector.trim())
    .filter(Boolean);
}

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
      "stored, the most recently used one becomes active. Pass one or more\n" +
      "accounts (email, username, user ID, or account ID; space- or\n" +
      "comma-separated) to remove those instead, or 'all' to remove every\n" +
      "stored account. When the same email is stored for several servers, add\n" +
      "--url <server> to pick the one on that server.\n\n" +
      "Examples:\n" +
      "  sentry auth logout\n" +
      "  sentry auth logout jane@acme.com,jane@personal.dev\n" +
      "  sentry auth logout jane@acme.com --url https://sentry.acme.com\n" +
      "  sentry auth logout all",
  },
  output: { human: formatLogoutResult },
  parameters: {
    flags: {
      url: {
        kind: "parsed",
        parse: parseLoginUrl,
        brief:
          "Only match accounts on this server (disambiguates the same email on several servers)",
        optional: true,
      },
    },
    positional: {
      kind: "array",
      parameter: {
        placeholder: "account",
        brief:
          "Accounts to log out of (email, username, user ID, or account ID; comma-separated), or 'all'",
        parse: String,
      },
    },
  },
  async *func(
    this: SentryContext,
    flags: LogoutFlags,
    ...args: readonly string[]
  ) {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      assertNotEnvOnly();
      return yield new CommandOutput<LogoutResult>({
        loggedOut: false,
        message: "Not currently authenticated.",
      });
    }

    const configPath = getDbPath();
    const selectors = parseLogoutSelectors(args);

    if (selectors.some((sel) => sel.toLowerCase() === ALL_ACCOUNTS)) {
      const { url } = flags;
      const removed = url
        ? accounts.filter((a) => isAccountOnServer(a, url))
        : accounts;
      if (removed.length === accounts.length) {
        await clearAuth();
      } else {
        await removeAccounts(removed);
      }
      return yield* finishLogout(removed, configPath, true);
    }

    let targets: AccountSummary[];
    if (selectors.length > 0) {
      targets = uniqueAccounts(
        selectors.map((sel) =>
          resolveAccountSelector(sel, COMMAND, { url: flags.url }),
        ),
      );
    } else {
      const active = accounts.find((a) => a.id === getActiveAccountId());
      targets = active ? [active] : [];
    }
    if (targets.length === 0) {
      return yield new CommandOutput<LogoutResult>({
        loggedOut: false,
        message:
          "No account is active. Run 'sentry auth list' and pass an account to log out of, or 'all'.",
      });
    }

    await removeAccounts(targets);
    return yield* finishLogout(targets, configPath, false);
  },
});

/**
 * Remove accounts, inactive ones first so promotion after removing the
 * active one never picks an account that is about to be removed too.
 */
async function removeAccounts(accounts: AccountSummary[]): Promise<void> {
  const ordered = [...accounts].sort(
    (a, b) => Number(a.active) - Number(b.active),
  );
  for (const account of ordered) {
    await removeAccount(account.id, { promoteNext: true });
  }
}

function uniqueAccounts(accounts: AccountSummary[]): AccountSummary[] {
  return accounts.filter(
    (account, index) =>
      accounts.findIndex((a) => a.id === account.id) === index,
  );
}

/** Report the removal and point the default URL at the new active account. */
async function* finishLogout(
  removed: AccountSummary[],
  configPath: string,
  all: boolean,
): AsyncGenerator<CommandOutput<LogoutResult>, void, undefined> {
  const nextActiveId = getActiveAccountId();
  const nextActiveRow = nextActiveId ? getAccountRow(nextActiveId) : undefined;
  const activeAccount = nextActiveRow
    ? toAccountSummary(nextActiveRow)
    : undefined;
  if (removed.some((a) => a.active) && activeAccount) {
    pointDefaultUrlAtAccount(activeAccount.host);
  }
  yield new CommandOutput<LogoutResult>({
    loggedOut: removed.length > 0,
    ...(removed.length === 0 ? { message: "No stored account matched." } : {}),
    configPath,
    removed,
    activeAccount,
    ...(all ? { all: true } : {}),
  });
}
