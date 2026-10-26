/**
 * Formatters for stored-account commands (`sentry auth list`, `switch`,
 * `logout`).
 */

import { type AccountSummary, hostnameOf } from "../db/accounts.js";
import { colorTag, escapeMarkdownInline, renderMarkdown } from "./markdown.js";
import { formatTable } from "./table.js";

/**
 * Short human label for an account, e.g. `Jane <jane@acme.com>`. The env
 * token's account names its variable, after its user when known:
 * `Jane <jane@acme.com> via SENTRY_AUTH_TOKEN`.
 */
export function formatAccountIdentity(account: AccountSummary): string {
  const displayName = account.name ?? account.username;
  let who: string | undefined;
  if (displayName && account.email) {
    who = `${displayName} <${account.email}>`;
  } else {
    who =
      displayName ??
      account.email ??
      (account.userId ? `user ${account.userId}` : undefined);
  }
  if (account.envVar) {
    return who ? `${who} via ${account.envVar}` : account.envVar;
  }
  return who ?? "unknown user";
}

/** Label including the server, e.g. `jane@acme.com on sentry.io`. */
export function formatAccountLabel(account: AccountSummary): string {
  const host = hostnameOf(account.host);
  const who = formatAccountIdentity(account);
  return host ? `${who} on ${host}` : who;
}

function accountStatus(account: AccountSummary): string {
  if (account.envVar) {
    return "env token";
  }
  if (!account.usable) {
    return colorTag("red", "logged out");
  }
  return account.active ? colorTag("green", "active") : "";
}

/** Data yielded by `sentry auth list`. */
export type AccountListResult = {
  accounts: AccountSummary[];
};

/** Human output for `sentry auth list`. */
export function formatAccountList(data: AccountListResult): string {
  if (data.accounts.length === 0) {
    return renderMarkdown("No stored accounts. Run `sentry auth login`.");
  }
  return formatTable(data.accounts, [
    { header: "", value: (a) => (a.active ? "*" : ""), minWidth: 1 },
    {
      header: "ACCOUNT",
      value: (a) => escapeMarkdownInline(formatAccountIdentity(a)),
    },
    {
      header: "SERVER",
      value: (a) => escapeMarkdownInline(hostnameOf(a.host) ?? "unknown"),
    },
    { header: "STATUS", value: accountStatus },
  ]);
}

/** Data yielded by `sentry auth switch`. */
export type AccountSwitchResult = {
  /** False when the selected account was already active. */
  switched: boolean;
  account: AccountSummary;
};

/** Human output for `sentry auth switch`. */
export function formatAccountSwitch(data: AccountSwitchResult): string {
  const label = escapeMarkdownInline(formatAccountLabel(data.account));
  const line = data.switched
    ? `${colorTag("green", "✓")} Switched to ${label}.`
    : `Already using ${label}.`;
  return renderMarkdown(line);
}
