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
import { type AccountSummary, listAccounts } from "../../lib/db/accounts.js";
import {
  getActiveEnvVarName,
  getAuthConfig,
  setActiveAccount,
} from "../../lib/db/auth.js";
import { AuthError } from "../../lib/errors.js";
import {
  type AccountSwitchResult,
  formatAccountSwitch,
} from "../../lib/formatters/accounts.js";
import { CommandOutput } from "../../lib/formatters/output.js";

const COMMAND = "sentry auth switch";

async function pickAccount(
  selector: string | undefined,
  accounts: AccountSummary[],
): Promise<AccountSummary | undefined> {
  if (selector !== undefined) {
    return resolveAccountSelector(selector, COMMAND);
  }
  const [only] = accounts;
  if (accounts.length === 1 && only) {
    return only;
  }
  return await promptForAccount(accounts, "Switch to which account?", COMMAND);
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
      "'sentry auth list --json'). When the same user is stored on several\n" +
      "servers, use '<email>@<server-hostname>'. Without an argument, pick from\n" +
      "a list interactively.\n\n" +
      "Examples:\n" +
      "  sentry auth switch\n" +
      "  sentry auth switch jane@acme.com\n" +
      "  sentry auth switch jane@acme.com@sentry.acme.com",
  },
  output: { human: formatAccountSwitch },
  parameters: {
    flags: {},
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
  async *func(this: SentryContext, _flags: object, selector?: string) {
    const accounts = listAccounts();
    if (accounts.length === 0) {
      throw new AuthError("not_authenticated", undefined, {
        skipAutoAuth: true,
      });
    }

    const target = await pickAccount(selector, accounts);
    if (!target) {
      return;
    }

    setActiveAccount(target.id);
    pointDefaultUrlAtAccount(target.host);
    const switched = !target.active;
    yield new CommandOutput<AccountSwitchResult>({
      switched,
      account: { ...target, active: true },
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
