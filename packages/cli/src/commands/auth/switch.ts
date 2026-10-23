/**
 * sentry auth switch [account]
 *
 * Change which stored account the CLI uses.
 */

import type { SentryContext } from "../../context.js";
import {
  pointDefaultUrlAtAccount,
  promptForAccount,
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
  getActiveEnvVarName,
  getAuthConfig,
  setActiveAccount,
} from "../../lib/db/auth.js";
import { AuthError, ResolutionError } from "../../lib/errors.js";
import {
  type AccountSwitchResult,
  formatAccountSwitch,
} from "../../lib/formatters/accounts.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { parseLoginUrl } from "./login.js";

const COMMAND = "sentry auth switch";

type SwitchFlags = {
  readonly url?: string;
};

async function pickAccount(
  selector: string | undefined,
  accounts: AccountSummary[],
  url: string | undefined,
): Promise<AccountSummary | undefined> {
  if (selector !== undefined) {
    return resolveAccountSelector(selector, COMMAND, { url, fuzzy: true });
  }
  const candidates = url
    ? accounts.filter((a) => isAccountOnServer(a, url))
    : accounts;
  if (candidates.length === 0) {
    throw new ResolutionError(
      `Account on '${url}'`,
      "not found",
      `${COMMAND} [account] --url <server>`,
      ["Run 'sentry auth list' to see stored accounts"],
    );
  }
  const [only] = candidates;
  if (candidates.length === 1 && only) {
    return only;
  }
  return await promptForAccount(
    candidates,
    "Switch to which account?",
    COMMAND,
  );
}

export const switchCommand = buildCommand({
  auth: false,
  skipRcUrlCheck: true,
  docs: {
    brief: "Switch the active account",
    fullDescription:
      "Make another stored account the active one. Subsequent commands use its\n" +
      "credentials and server (the default URL is updated to match; SENTRY_HOST\n" +
      "and SENTRY_URL still take precedence).\n\n" +
      "Select the account by email, username, user ID, or account ID (see\n" +
      "'sentry auth list --json'). A close but inexact match (e.g. 'jane' for\n" +
      "'jane@acme.com') is used with a warning when it is the only one. When\n" +
      "the same user is stored on several servers, add --url <server> (or use\n" +
      "'<email>@<server-hostname>'). Without an argument, pick from a\n" +
      "searchable list interactively.",
    examples: [
      {
        description: "Pick the active account from a searchable list",
        command: "sentry auth switch",
      },
      {
        description: "Switch to a specific account",
        command: "sentry auth switch jane@example.com",
      },
      {
        description:
          "Pick the account on one server when the same email is stored twice",
        command:
          "sentry auth switch jane@example.com --url https://sentry.example.com",
      },
    ],
  },
  output: { human: formatAccountSwitch },
  parameters: {
    flags: {
      url: {
        kind: "parsed",
        parse: parseLoginUrl,
        brief:
          "Only consider accounts on this server (disambiguates the same email on several servers)",
        optional: true,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "account",
          brief: "Email, username, user ID, or account ID to switch to",
          parse: String,
          optional: true,
        },
      ],
    },
  },
  async *func(this: SentryContext, flags: SwitchFlags, selector?: string) {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      throw new AuthError("not_authenticated", undefined, {
        skipAutoAuth: true,
      });
    }

    const target = await pickAccount(selector, accounts, flags.url);
    if (!target) {
      return;
    }

    setActiveAccount(target.id);
    // Re-read: activation backfills a legacy account's missing host.
    const activeRow = getAccountRow(target.id);
    const active = activeRow ? toAccountSummary(activeRow) : target;
    pointDefaultUrlAtAccount(active.host);
    const switched = !target.active;
    yield new CommandOutput<AccountSwitchResult>({
      switched,
      account: { ...active, active: true },
    });

    if (!target.usable) {
      return {
        hint: "This account's session has ended. Run 'sentry auth login' to log in again.",
      };
    }
    if (getAuthConfig()?.source.startsWith("env:")) {
      return {
        hint: `${getActiveEnvVarName()} is set and overrides stored accounts.`,
      };
    }
  },
});
