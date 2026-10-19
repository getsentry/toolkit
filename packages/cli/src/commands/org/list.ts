/**
 * sentry org list
 *
 * List organizations the user has access to — across every stored account
 * when several are logged in.
 */

import type { SentryContext } from "../../context.js";
import { resolveAccountSelector } from "../../lib/account-selection.js";
import { listOrganizationsUncached } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { DEFAULT_SENTRY_HOST } from "../../lib/constants.js";
import {
  type AccountSummary,
  isSameServer,
  toAccountSummary,
} from "../../lib/db/accounts.js";
import {
  listUsableAccountsInScope,
  withStoredAccount,
} from "../../lib/db/auth.js";
import { getAllOrgRegions } from "../../lib/db/regions.js";
import { ApiError, AuthError } from "../../lib/errors.js";
import { formatAccountLabel } from "../../lib/formatters/accounts.js";
import { escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { type Column, writeTable } from "../../lib/formatters/table.js";
import {
  applyFreshFlag,
  buildListLimitFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { withProgress } from "../../lib/polling.js";
import type { SentryOrganization, Writer } from "../../types/index.js";

type ListFlags = {
  readonly limit: number;
  readonly json: boolean;
  readonly fresh: boolean;
  readonly account?: string;
  readonly fields?: string[];
};

/** The stored account an organization was listed under (no secrets). */
type OrgListAccount = {
  id: string;
  host?: string;
  email?: string;
  username?: string;
  /** Human label, e.g. `jane@acme.com on sentry.io`. */
  label: string;
};

/**
 * An organization enriched with an optional region display name and the
 * stored account it was listed under.
 *
 * The `region` field is only present when the user's orgs span multiple
 * regions (e.g. both US and EU). `account` is only present when orgs from
 * several stored accounts are listed. Both are included in JSON output as
 * well, providing context to machine consumers.
 */
type OrgListEntry = SentryOrganization & {
  region?: string;
  account?: OrgListAccount;
};

/** One account's fetched orgs plus its slug → region URL cache. */
type AccountOrgs = {
  account?: AccountSummary;
  orgs: SentryOrganization[];
  regions: Map<string, string>;
};

/**
 * Extract a human-readable region name from a region URL.
 * Strips the .sentry.io suffix and maps known regions to display names.
 *
 * @example "https://sentry.io" -> "US" (default)
 * @example "https://us.sentry.io" -> "US"
 * @example "https://de.sentry.io" -> "EU"
 * @example "https://east-1.us.sentry.io" -> "EAST-1.US"
 */
const log = logger.withTag("org.list");

function getRegionDisplayName(regionUrl: string): string {
  try {
    const url = new URL(regionUrl);
    const { hostname } = url;

    // Strip .sentry.io suffix to get the region identifier
    const suffix = `.${DEFAULT_SENTRY_HOST}`;
    let regionPart: string;
    if (hostname === DEFAULT_SENTRY_HOST) {
      regionPart = "sentry"; // sentry.io -> sentry (US default)
    } else if (hostname.endsWith(suffix)) {
      regionPart = hostname.slice(0, -suffix.length); // us.sentry.io -> us
    } else {
      regionPart = hostname; // Non-sentry domain, use as-is
    }

    const regionMap: Record<string, string> = {
      us: "US",
      de: "EU",
      sentry: "US", // sentry.io defaults to US
    };
    return regionMap[regionPart] ?? regionPart.toUpperCase();
  } catch (error) {
    log.debug(`Failed to parse region URL "${regionUrl}"`, error);
    return "?";
  }
}

/**
 * Format org list entries as a human-readable table.
 *
 * Includes a REGION column only when at least one entry has a region set
 * (indicating the user's orgs span multiple regions).
 */
function formatOrgListHuman(entries: OrgListEntry[]): string {
  if (entries.length === 0) {
    return "No organizations found.";
  }

  const showRegion = entries.some((e) => e.region !== undefined);
  const showAccount = entries.some((e) => e.account !== undefined);

  type OrgRow = {
    slug: string;
    name: string;
    region?: string;
    account?: string;
  };
  const rows: OrgRow[] = entries.map((org) => ({
    slug: org.slug,
    name: org.name,
    region: showRegion ? (org.region ?? "") : undefined,
    account: org.account?.label,
  }));

  const columns: Column<OrgRow>[] = [
    { header: "SLUG", value: (r) => r.slug },
    ...(showRegion
      ? [{ header: "REGION", value: (r: OrgRow) => r.region ?? "" }]
      : []),
    { header: "NAME", value: (r) => escapeMarkdownCell(r.name) },
    ...(showAccount
      ? [
          {
            header: "ACCOUNT",
            value: (r: OrgRow) => escapeMarkdownCell(r.account ?? ""),
          },
        ]
      : []),
  ];

  const parts: string[] = [];
  const buffer: Writer = { write: (s: string) => parts.push(s) };
  writeTable(buffer, rows, columns);

  return parts.join("").trimEnd();
}

function toOrgListAccount(account: AccountSummary): OrgListAccount {
  return {
    id: account.id,
    ...(account.host ? { host: account.host } : {}),
    ...(account.email ? { email: account.email } : {}),
    ...(account.username ? { username: account.username } : {}),
    label: formatAccountLabel(account),
  };
}

/** Fetch orgs (and their cached regions) with the credentials in effect. */
async function fetchOrgs(account?: AccountSummary): Promise<AccountOrgs> {
  const orgs = await listOrganizationsUncached();
  return { account, orgs, regions: getAllOrgRegions() };
}

/** Fetch `account`'s orgs with its own credentials, on its own server. */
function fetchAccountOrgs(account: AccountSummary): Promise<AccountOrgs> {
  const host = account.host;
  if (!host) {
    return Promise.reject(
      new AuthError("not_authenticated", "Account has no server recorded.", {
        skipAutoAuth: true,
      }),
    );
  }
  return withStoredAccount({ id: account.id, host }, () => fetchOrgs(account));
}

/**
 * Fetch every account's orgs concurrently. An account that fails (expired
 * login, unreachable server) is skipped with a warning so the others are
 * still listed; when every account fails, the first error is thrown.
 */
async function fetchOrgsAcrossAccounts(
  accounts: AccountSummary[],
): Promise<AccountOrgs[]> {
  const settled = await Promise.allSettled(accounts.map(fetchAccountOrgs));
  const fetched: AccountOrgs[] = [];
  let firstError: unknown;
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      fetched.push(result.value);
      return;
    }
    const error = result.reason;
    if (!(error instanceof AuthError || error instanceof ApiError)) {
      throw error;
    }
    firstError ??= error;
    const account = accounts[i];
    log.warn(
      `Skipped ${account ? formatAccountLabel(account) : "an account"}: ${error.message}`,
    );
  });
  if (fetched.length === 0 && firstError !== undefined) {
    throw firstError;
  }
  return fetched;
}

/**
 * Flatten per-account results into list entries. An org reachable from
 * several accounts on the same server is listed once, under the first of
 * them (the active account, else the most recently used).
 */
function mergeAccountOrgs(results: AccountOrgs[]): {
  orgs: SentryOrganization[];
  accountOf: Map<SentryOrganization, AccountSummary | undefined>;
  regionOf: Map<SentryOrganization, string | undefined>;
} {
  const orgs: SentryOrganization[] = [];
  const accountOf = new Map<SentryOrganization, AccountSummary | undefined>();
  const regionOf = new Map<SentryOrganization, string | undefined>();
  const seen: { host: string; slug: string }[] = [];
  for (const { account, orgs: accountOrgs, regions } of results) {
    for (const org of accountOrgs) {
      const host = account?.host;
      if (
        host &&
        seen.some((s) => s.slug === org.slug && isSameServer(s.host, host))
      ) {
        continue;
      }
      if (host) {
        seen.push({ host, slug: org.slug });
      }
      orgs.push(org);
      accountOf.set(org, account);
      regionOf.set(org, regions.get(org.slug));
    }
  }
  return { orgs, accountOf, regionOf };
}

/**
 * Which stored accounts to list: the one named by `--account`, else every
 * usable account in scope. `undefined` means "the credentials in effect"
 * (no usable stored account, only the active one, or a forced env token),
 * which keeps the single-account output unchanged. A single usable account
 * that isn't the active one (say, the active login was logged out) is
 * listed with its own credentials.
 */
function resolveAccounts(selector?: string): AccountSummary[] | undefined {
  if (selector !== undefined) {
    const account = resolveAccountSelector(
      selector,
      "sentry org list --account",
      {
        fuzzy: true,
      },
    );
    if (!account.usable) {
      const who = account.email ?? account.username;
      const relogin = who ? `sentry auth login ${who}` : "sentry auth login";
      throw new AuthError(
        "expired",
        `${formatAccountLabel(account)} is logged out. Run '${relogin}'.`,
        { skipAutoAuth: true },
      );
    }
    return [account];
  }
  // The active account first, then most recently used: its orgs lead the
  // list, and an org it shares with another account is listed under it.
  const accounts = listUsableAccountsInScope()
    .map(toAccountSummary)
    .sort((a, b) => Number(b.active) - Number(a.active));
  const [only] = accounts;
  return accounts.length > 1 || (only && !only.active) ? accounts : undefined;
}

export const listCommand = buildCommand({
  docs: {
    brief: "List organizations",
    fullDescription:
      "List organizations that you have access to.\n\n" +
      "With several stored accounts (see 'sentry auth list'), organizations\n" +
      "from every logged-in account are listed together, with an ACCOUNT\n" +
      "column showing which login reaches each one. Commands targeting an\n" +
      "organization use that account automatically. An organization reachable\n" +
      "from several accounts on the same server is listed once. Accounts whose\n" +
      "login fails are skipped with a warning. SENTRY_HOST/SENTRY_URL limits the\n" +
      "list to accounts on that server; --account limits it to one account.\n\n" +
      "Examples:\n" +
      "  sentry org list\n" +
      "  sentry org list --limit 10\n" +
      "  sentry org list --account jane@example.com\n" +
      "  sentry org list --json\n\n" +
      "Alias: `sentry orgs` → `sentry org list`",
  },
  output: { human: formatOrgListHuman },
  parameters: {
    flags: {
      limit: buildListLimitFlag("organizations"),
      fresh: FRESH_FLAG,
      account: {
        kind: "parsed",
        parse: String,
        brief:
          "Only list organizations of this stored account (email, username, or account id)",
        optional: true,
      },
    },
    // Only -n for --limit; no -c since org list has no --cursor flag
    aliases: { ...FRESH_ALIASES, n: "limit" },
  },
  async *func(this: SentryContext, flags: ListFlags) {
    applyFreshFlag(flags);

    const accounts = resolveAccounts(flags.account);
    const crossAccount = accounts !== undefined && accounts.length > 1;
    const results = await withProgress(
      {
        message: crossAccount
          ? `Fetching organizations from ${accounts.length} accounts (up to ${flags.limit})...`
          : `Fetching organizations (up to ${flags.limit})...`,
        json: flags.json,
      },
      async () => {
        if (!accounts) {
          return [await fetchOrgs()];
        }
        return crossAccount
          ? await fetchOrgsAcrossAccounts(accounts)
          : await Promise.all(accounts.map(fetchAccountOrgs));
      },
    );
    const { orgs, accountOf, regionOf } = mergeAccountOrgs(results);
    const limitedOrgs = orgs.slice(0, flags.limit);

    // Show regions when one login's orgs span several (e.g. US and EU).
    // Accounts on different servers alone don't count: ACCOUNT shows those.
    const showRegion = results.some(
      ({ orgs: accountOrgs, regions }) =>
        new Set(
          accountOrgs.flatMap((org) => {
            const region = regions.get(org.slug);
            return region ? [region] : [];
          }),
        ).size > 1,
    );

    const entries: OrgListEntry[] = limitedOrgs.map((org) => {
      const account = crossAccount ? accountOf.get(org) : undefined;
      return {
        ...org,
        region: showRegion
          ? getRegionDisplayName(regionOf.get(org) ?? "")
          : undefined,
        ...(account ? { account: toOrgListAccount(account) } : {}),
      };
    });

    const hints: string[] = [];
    if (orgs.length > flags.limit) {
      hints.push(`Showing ${flags.limit} of ${orgs.length} organizations`);
    }
    if (entries.length > 0) {
      hints.push("Tip: Use 'sentry org view <slug>' for details");
    }

    yield new CommandOutput(entries);
    return { hint: hints.join("\n") || undefined };
  },
});
