/**
 * sentry auth list
 *
 * List stored Sentry accounts.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { listAccounts } from "../../lib/db/accounts.js";
import { getActiveEnvVarName, getAuthConfig } from "../../lib/db/auth.js";
import {
  type AccountListResult,
  formatAccountList,
} from "../../lib/formatters/accounts.js";
import { CommandOutput } from "../../lib/formatters/output.js";

export const listCommand = buildCommand({
  auth: false,
  skipRcUrlCheck: true,
  docs: {
    brief: "List stored accounts",
    fullDescription:
      "List every Sentry account stored by 'sentry auth login', across servers.\n\n" +
      "The active account (marked with *) is used for commands. Log in again to add\n" +
      "another account, and use 'sentry auth switch' to change the active one.",
  },
  output: {
    human: formatAccountList,
    jsonTransform: (data: AccountListResult) => data.accounts,
  },
  parameters: {
    flags: {},
  },
  async *func(this: SentryContext) {
    const accounts = listAccounts();
    yield new CommandOutput<AccountListResult>({ accounts });

    if (getAuthConfig()?.source.startsWith("env:")) {
      return {
        hint: `${getActiveEnvVarName()} is in use and overrides stored accounts.`,
      };
    }
    if (accounts.length > 1) {
      return { hint: "Switch accounts with 'sentry auth switch <email>'." };
    }
    return { hint: "Add another account with 'sentry auth login --force'." };
  },
});
