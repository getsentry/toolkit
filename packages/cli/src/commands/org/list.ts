/**
 * sentry org list
 *
 * List organizations the user has access to — across every stored account
 * when several are logged in.
 */

import picomatch from "picomatch";
import type { SentryContext } from "../../context.js";
import { resolveAccountSelector } from "../../lib/account-selection.js";
import { listOrganizationsUncached } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { DEFAULT_SENTRY_HOST } from "../../lib/constants.js";
import {
  type AccountSummary,
  accountSelectorOf,
  accountSelectorParts,
  serverKey,
  toAccountSummary,
} from "../../lib/db/accounts.js";
import {
  listUsableAccountsInScope,
  withStoredAccount,
} from "../../lib/db/auth.js";
import { getAllOrgRegions } from "../../lib/db/regions.js";
import { ApiError, AuthError } from "../../lib/errors.js";
import { formatAccountLabel } from "../../lib/formatters/accounts.js";
import { fuzzyMatch } from "../../lib/fuzzy.js";
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
  /** Human label, e.g. `Jane <jane@acme.com> on sentry.io`. */
  label: string;
  /** What `--account` accepts, e.g. `jane@acme.com:sentry.io`. */
  selector: string;
  /**
   * `selector` already split: `who` (email, else username, else id) and
   * `server` (`host[:port]`, absent when no host is recorded).
   */
  selectorParts: { who: string; server?: string };
};

/** Optional account fields copied into {@link OrgListAccount} when set. */
const ORG_LIST_ACCOUNT_FIELDS = ["host", "email", "username"] as const;

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

/** Table columns in display order: header → the entry's cell value. */
const ORG_LIST_COLUMNS: Record<
  string,
  (e: OrgListEntry) => string | undefined
> = {
  SLUG: (e) => e.slug,
  REGION: (e) => e.region,
  NAME: (e) => e.name,
  ACCOUNT: (e) => e.account?.selector,
};

/** Columns shown only when at least one entry has a value for them. */
const OPTIONAL_ORG_LIST_COLUMNS = new Set(["REGION", "ACCOUNT"]);

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

  // REGION and ACCOUNT only appear when some entry has one.
  const columns: Column<OrgListEntry>[] = Object.entries(ORG_LIST_COLUMNS)
    .filter(
      ([header, value]) =>
        !OPTIONAL_ORG_LIST_COLUMNS.has(header) ||
        entries.some((e) => value(e) !== undefined),
    )
    .map(([header, value]) => ({
      header,
      value: (e) => escapeMarkdownCell(value(e) ?? ""),
    }));

  const parts: string[] = [];
  const buffer: Writer = { write: (s: string) => parts.push(s) };
  writeTable(buffer, entries, columns);

  return parts.join("").trimEnd();
}

function toOrgListAccount(account: AccountSummary): OrgListAccount {
  const entry: OrgListAccount = {
    id: account.id,
    label: formatAccountLabel(account),
    selector: accountSelectorOf(account),
    selectorParts: accountSelectorParts(account),
  };
  for (const field of ORG_LIST_ACCOUNT_FIELDS) {
    const value = account[field];
    if (value) {
      entry[field] = value;
    }
  }
  return entry;
}

/** Fetch orgs (and their cached regions) with the credentials in effect. */
async function fetchOrgs(account?: AccountSummary): Promise<AccountOrgs> {
  const orgs = await listOrganizationsUncached();
  return { account, orgs, regions: getAllOrgRegions() };
}

/** Fetch `account`'s orgs with its own credentials, on its own server. */
async function fetchAccountOrgs(account: AccountSummary): Promise<AccountOrgs> {
  const host = account.host;
  if (!host) {
    throw new AuthError(
      "not_authenticated",
      "Account has no server recorded.",
      { skipAutoAuth: true },
    );
  }
  return await withStoredAccount({ id: account.id, host }, () =>
    fetchOrgs(account),
  );
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
  for (const [i, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      fetched.push(result.value);
      continue;
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
  }
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
  // `<server key> <slug>` of every org listed so far.
  const seen = new Set<string>();
  for (const { account, orgs: accountOrgs, regions } of results) {
    const server = account?.host ? serverKey(account.host) : undefined;
    for (const org of accountOrgs) {
      if (server) {
        const key = `${server} ${org.slug}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
      }
      orgs.push(org);
      accountOf.set(org, account);
      regionOf.set(org, regions.get(org.slug));
    }
  }
  return { orgs, accountOf, regionOf };
}

/** Glob metacharacters: a filter with any of them is matched as a glob. */
const GLOB_CHARS_RE = /[*?[\]{}]/;

/**
 * Orgs whose slug or name matches `filter`, case-insensitively. A glob
 * (`acme-*`) must match the whole slug or name and keeps the list order.
 * Plain text uses the shared {@link fuzzyMatch} search (exact, prefix,
 * substring, then small typos), best matches first.
 */
function filterOrgs(
  orgs: SentryOrganization[],
  filter: string | undefined,
): SentryOrganization[] {
  const needle = filter?.trim().toLowerCase();
  if (!needle) {
    return orgs;
  }
  if (GLOB_CHARS_RE.test(needle)) {
    const matches = picomatch(needle, { dot: true });
    return orgs.filter(
      (org) =>
        matches(org.slug.toLowerCase()) || matches(org.name.toLowerCase()),
    );
  }
  const candidates = [...new Set(orgs.flatMap((org) => [org.slug, org.name]))];
  const rankOf = new Map(
    fuzzyMatch(needle, candidates, { mode: "search" }).map((value, rank) => [
      value,
      rank,
    ]),
  );
  // An org ranks by its better-matching slug or name; the sort is stable.
  return orgs
    .map((org) => ({
      org,
      rank: Math.min(
        rankOf.get(org.slug) ?? Number.POSITIVE_INFINITY,
        rankOf.get(org.name) ?? Number.POSITIVE_INFINITY,
      ),
    }))
    .filter(({ rank }) => rank !== Number.POSITIVE_INFINITY)
    .sort((a, b) => a.rank - b.rank)
    .map(({ org }) => org);
}

/**
 * The command that logs back in to `account`: `sentry auth login
 * <email>:<server>` when its email is known, else `--url <server>`.
 */
function reloginCommand(account: AccountSummary): string {
  if (account.email) {
    return `sentry auth login ${accountSelectorOf(account)}`;
  }
  return account.host
    ? `sentry auth login --url ${account.host}`
    : "sentry auth login";
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
      throw new AuthError(
        "expired",
        `${formatAccountLabel(account)} is logged out. Run '${reloginCommand(account)}'.`,
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
      "list to accounts on that server; --account limits it to one account\n" +
      "(an email, username, or account id; add :<server> to pick one server's\n" +
      "login, e.g. jane@example.com:sentry.example.com, as shown in ACCOUNT).\n\n" +
      "Pass a filter to only list organizations whose slug or name matches it,\n" +
      "ignoring case: exactly, as a prefix or substring, or with a small typo\n" +
      "(best matches first), or as a glob like 'acme-*'.\n\n" +
      "Examples:\n" +
      "  sentry org list\n" +
      "  sentry org list acme\n" +
      "  sentry org list 'acme-*'\n" +
      "  sentry org list --limit 10\n" +
      "  sentry org list --account jane@example.com\n" +
      "  sentry org list -a jane@example.com:sentry.example.com\n" +
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
          "Only list organizations of this stored account (email, username, or account id; <who>:<server> for one server)",
        optional: true,
      },
    },
    // Only -n for --limit; no -c since org list has no --cursor flag
    aliases: { ...FRESH_ALIASES, n: "limit", a: "account" },
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "filter",
          brief:
            "Only list organizations whose slug or name fuzzy-matches this text or matches this glob",
          parse: String,
          optional: true,
        },
      ],
    },
  },
  async *func(this: SentryContext, flags: ListFlags, filter?: string) {
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
    const merged = mergeAccountOrgs(results);
    const { accountOf, regionOf } = merged;
    const orgs = filterOrgs(merged.orgs, filter);
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
    } else if (filter && merged.orgs.length > 0) {
      hints.push(
        `None of your ${merged.orgs.length} organizations match '${filter}'. Run 'sentry org list' to see them all.`,
      );
    }

    yield new CommandOutput(entries);
    return { hint: hints.join("\n") || undefined };
  },
});
