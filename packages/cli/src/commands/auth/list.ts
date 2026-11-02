/**
 * sentry auth list
 *
 * List stored Sentry accounts.
 */

import {
  boolean,
  description,
  looseObject,
  number,
  optional,
  pipe,
  string,
} from "valibot";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { listAccounts } from "../../lib/db/accounts.js";
import {
  getActiveEnvVarName,
  getAuthConfig,
  getEnvAccount,
} from "../../lib/db/auth.js";
import { describeEnvAccount } from "../../lib/env-account.js";
import {
  type AccountListResult,
  formatAccountList,
} from "../../lib/formatters/accounts.js";
import { filterFieldsIfSet } from "../../lib/formatters/json.js";
import { CommandOutput } from "../../lib/formatters/output.js";

/** `--fields` / skill-reference schema for one listed account. */
const AccountSummarySchema = looseObject({
  id: pipe(string(), description("Account ID")),
  active: pipe(boolean(), description("Whether commands use this account")),
  host: optional(pipe(string(), description("Sentry server URL"))),
  userId: optional(pipe(string(), description("User ID"))),
  email: optional(pipe(string(), description("User email"))),
  username: optional(pipe(string(), description("Username"))),
  name: optional(pipe(string(), description("User display name"))),
  usable: pipe(
    boolean(),
    description("Whether the credential can still be used or refreshed"),
  ),
  expiresAt: optional(
    pipe(number(), description("Token expiry (Unix milliseconds)")),
  ),
  envVar: optional(
    pipe(string(), description("Env var providing the token, if not stored")),
  ),
});

export const listCommand = buildCommand({
  auth: false,
  skipRcUrlCheck: true,
  docs: {
    brief: "List stored accounts",
    fullDescription:
      "List every Sentry account stored by 'sentry auth login', across servers.\n\n" +
      "The active account (marked with *) is used for commands. Log in again to add\n" +
      "another account, and use 'sentry auth switch' to change the active one.\n\n" +
      "SENTRY_AUTH_TOKEN (or SENTRY_TOKEN) is listed too when its server is known\n" +
      "(an organization auth token's own URL, or sentry.io), with the user\n" +
      "it belongs to when the server says. It is never stored and can't be\n" +
      "switched to: commands targeting an organization it can access use it.",
    examples: [
      {
        description: "Show stored accounts (* marks the active one)",
        command: "sentry auth list",
      },
    ],
  },
  output: {
    human: formatAccountList,
    jsonTransform: (data: AccountListResult, fields?: string[]) =>
      filterFieldsIfSet(data.accounts, fields),
    schema: AccountSummarySchema,
  },
  parameters: {
    flags: {},
  },
  async *func(this: SentryContext) {
    const stored = listAccounts();
    const envAccount = getEnvAccount();
    const accounts = envAccount
      ? [...stored, await describeEnvAccount(envAccount)]
      : stored;
    yield new CommandOutput<AccountListResult>({ accounts });

    if (getAuthConfig()?.source.startsWith("env:")) {
      return {
        hint: `${getActiveEnvVarName()} is in use and overrides stored accounts.`,
      };
    }
    if (stored.length > 1) {
      return { hint: "Switch accounts with 'sentry auth switch <email>'." };
    }
    if (stored.length === 0) {
      return { hint: "Log in with 'sentry auth login'." };
    }
    return { hint: "Add another account with 'sentry auth login'." };
  },
});
