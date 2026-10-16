/**
 * Helpers for the account commands: resolve which stored account a
 * `sentry auth switch` / `logout` argument refers to (or ask interactively),
 * and keep the default URL pointed at the active account's server.
 */

import { isatty } from "node:tty";
import { isSaaSTrustOrigin } from "@sentry/toolkit-core/sentry-origin";
import {
  type AccountSummary,
  findAccounts,
  findSimilarAccounts,
  hostnameOf,
  isAccountOnServer,
} from "./db/accounts.js";
import { getDefaultUrl, setDefaultUrl } from "./db/defaults.js";
import { ContextError, ResolutionError } from "./errors.js";
import { formatAccountLabel } from "./formatters/accounts.js";
import { logger } from "./logger.js";

const log = logger.withTag("auth.accounts");

/** Options for {@link resolveAccountSelector}. */
export type AccountSelectorOptions = {
  /**
   * Only consider accounts on this server (`--url`). Disambiguates the same
   * email or username stored for several servers.
   */
  url?: string;
  /**
   * Use a sole fuzzy match (with a warning) when nothing matches exactly.
   * Off by default; destructive commands like `logout` only suggest.
   */
  fuzzy?: boolean;
};

function onServer(
  accounts: AccountSummary[],
  url: string | undefined,
): AccountSummary[] {
  return url ? accounts.filter((a) => isAccountOnServer(a, url)) : accounts;
}

function describeAccount(account: AccountSummary): string {
  return `${formatAccountLabel(account)} (id: ${account.id})`;
}

/**
 * Resolve a user-supplied selector (account id, email, username, user id,
 * or `<who>@<server-hostname>`) to exactly one stored account. Without an
 * exact match, similar accounts from the shared fuzzy matcher are suggested
 * (or, with `fuzzy`, a sole one is used).
 *
 * @throws {ResolutionError} when nothing or more than one account matches
 */
export function resolveAccountSelector(
  selector: string,
  command: string,
  options: AccountSelectorOptions = {},
): AccountSummary {
  const where = options.url ? ` on ${hostnameOf(options.url)}` : "";
  const matches = onServer(findAccounts(selector), options.url);
  const [match] = matches;
  if (matches.length === 1 && match) {
    return match;
  }
  if (matches.length > 1) {
    throw new ResolutionError(
      `Account '${selector}'${where}`,
      "matches more than one stored account",
      `${command} <account-id>`,
      [
        ...matches.map(describeAccount),
        "Add --url <server> or use the account id to pick one",
      ],
    );
  }

  const similar = onServer(findSimilarAccounts(selector), options.url);
  const [sole] = similar;
  if (options.fuzzy && similar.length === 1 && sole) {
    log.warn(
      `No account matching '${selector}'. Using ${formatAccountLabel(sole)}.`,
    );
    return sole;
  }
  throw new ResolutionError(
    `Account '${selector}'${where}`,
    "not found",
    `${command} <email|username|account-id>`,
    similar.length > 0
      ? [
          ...similar.map((a) => `Did you mean ${describeAccount(a)}?`),
          "Run 'sentry auth list' to see stored accounts",
        ]
      : ["Run 'sentry auth list' to see stored accounts"],
  );
}

/**
 * Ask the user to pick one of `accounts` in an interactive terminal, with
 * type-to-filter fuzzy search (the same picker as org/project selection).
 * Returns `undefined` when the prompt is cancelled.
 *
 * @throws {ContextError} when stdin is not a TTY
 */
export async function promptForAccount(
  accounts: readonly AccountSummary[],
  message: string,
  command: string,
): Promise<AccountSummary | undefined> {
  if (!isatty(0)) {
    throw new ContextError(
      "Account",
      `${command} <email|username|account-id>`,
      accounts.map(describeAccount),
    );
  }
  const { selectWithFilter } = await import("./init/ui/ink-ui.js");
  const selected = await selectWithFilter({
    message,
    options: accounts.map((a) => ({
      label: formatAccountLabel(a),
      value: a.id,
      hint: a.active ? "active" : a.usable ? undefined : "logged out",
    })),
    initialValue: accounts.find((a) => a.active)?.id,
  });
  return selected === null
    ? undefined
    : accounts.find((a) => a.id === selected);
}

/**
 * Point the persisted default URL (`defaults.url`) at an account's server
 * so later commands route to it: self-hosted hosts are stored, SaaS clears
 * the default. Explicit `SENTRY_HOST`/`SENTRY_URL` still take precedence.
 */
export function pointDefaultUrlAtAccount(host: string | undefined): void {
  if (!host) {
    return;
  }
  if (isSaaSTrustOrigin(host)) {
    if (getDefaultUrl()) {
      setDefaultUrl(null);
    }
    return;
  }
  setDefaultUrl(host);
}
