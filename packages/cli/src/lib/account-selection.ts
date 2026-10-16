/**
 * Helpers for the account commands: resolve which stored account a
 * `sentry auth switch` / `logout` argument refers to (or ask interactively),
 * and keep the default URL pointed at the active account's server.
 */

import { isatty } from "node:tty";
import { isSaaSTrustOrigin } from "@sentry/toolkit-core/sentry-origin";
import { type AccountSummary, findAccounts } from "./db/accounts.js";
import { getDefaultUrl, setDefaultUrl } from "./db/defaults.js";
import { ContextError, ResolutionError } from "./errors.js";
import { formatAccountLabel } from "./formatters/accounts.js";
import { logger } from "./logger.js";

const log = logger.withTag("auth.accounts");

/**
 * Resolve a user-supplied selector (account id, email, username, user id,
 * or `<who>@<server-hostname>`) to exactly one stored account.
 *
 * @throws {ResolutionError} when nothing or more than one account matches
 */
export function resolveAccountSelector(
  selector: string,
  command: string,
): AccountSummary {
  const matches = findAccounts(selector);
  const [match] = matches;
  if (matches.length === 1 && match) {
    return match;
  }
  if (matches.length === 0) {
    throw new ResolutionError(
      `Account '${selector}'`,
      "not found",
      `${command} <email|username|account-id>`,
      ["Run 'sentry auth list' to see stored accounts"],
    );
  }
  throw new ResolutionError(
    `Account '${selector}'`,
    "matches more than one stored account",
    `${command} <account-id>`,
    [
      ...matches.map((a) => `${formatAccountLabel(a)} (id: ${a.id})`),
      "Use '<email>@<server>' or the account id to pick one",
    ],
  );
}

/**
 * Ask the user to pick one of `accounts` in an interactive terminal.
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
      accounts.map((a) => `${formatAccountLabel(a)} (id: ${a.id})`),
    );
  }
  const selected = await log.prompt(message, {
    type: "select",
    options: accounts.map((a) => ({
      label: formatAccountLabel(a),
      value: a.id,
      hint: a.active ? "active" : a.usable ? undefined : "logged out",
    })),
    initial: accounts.find((a) => a.active)?.id,
  });
  // Cancel resolves to Symbol(clack:cancel); only accept a known id.
  return typeof selected === "string"
    ? accounts.find((a) => a.id === selected)
    : undefined;
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
