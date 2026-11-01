/**
 * sentry org list
 *
 * List organizations the user has access to — across every stored account
 * when several are logged in.
 */

import { description, looseObject, optional, pipe, string } from "valibot";
import type { SentryContext } from "../../context.js";
import { resolveAccountSelector } from "../../lib/account-selection.js";
import { listOrganizationsUncached } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import {
  parseAccountSelector,
  parseOrgSlug,
} from "../../lib/completion-target.js";
import { DEFAULT_SENTRY_HOST } from "../../lib/constants.js";
import {
  type AccountSummary,
  accountSelectorOf,
  accountServerOf,
  serverKey,
  toAccountSummary,
  toEnvAccountSummary,
} from "../../lib/db/accounts.js";
import {
  getEnvAccount,
  getEnvAccountInScope,
  listUsableAccountsInScope,
  withEnvAccount,
  withStoredAccount,
} from "../../lib/db/auth.js";
import { fetchEnvAccountUser } from "../../lib/env-account.js";
import { getAllOrgRegions } from "../../lib/db/regions.js";
import { ApiError, AuthError } from "../../lib/errors.js";
import { formatAccountLabel } from "../../lib/formatters/accounts.js";
import { getNestedValue } from "../../lib/formatters/json.js";
import { escapeMarkdownCell } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { type Column, writeTable } from "../../lib/formatters/table.js";
import { filterByName } from "../../lib/list-filter.js";
import {
  applyFreshFlag,
  buildListLimitFlag,
  FRESH_ALIASES,
  FRESH_FLAG,
} from "../../lib/list-command.js";
import { logger } from "../../lib/logger.js";
import { withProgress } from "../../lib/polling.js";
import {
  type SentryOrganization,
  SentryOrganizationSchema,
  type Writer,
} from "../../types/index.js";

type ListFlags = {
  readonly limit: number;
  readonly json: boolean;
  readonly fresh: boolean;
  readonly account?: string;
  readonly fields?: string[];
};

/**
 * The account an organization was listed under (no secrets): a stored
 * account, or the env token's virtual account.
 */
type OrgListAccount = {
  /**
   * What `--account` accepts: `<who>:<server>`, e.g.
   * `jane@acme.com:sentry.io` (just `<who>` when no server is recorded), as
   * `sentry auth login` does too; `env:SENTRY_AUTH_TOKEN` for the env token.
   */
  name: string;
  id: string;
  email?: string;
  username?: string;
  /**
   * The server part of `name`: `host[:port]`, or the full origin such as
   * `http://localhost:8000` for a non-HTTPS server.
   */
  server?: string;
  /** The server's full origin, e.g. `https://sentry.io`. */
  host?: string;
  /** Human label, e.g. `Jane <jane@acme.com> on sentry.io`. */
  label: string;
  /** The variable providing the token, for the env token's account. */
  envVar?: string;
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

/** JSON fields of an {@link OrgListEntry}, for `--fields`. */
const OrgListEntrySchema = looseObject({
  ...SentryOrganizationSchema.entries,
  region: optional(
    pipe(string(), description("Region, when orgs span several (e.g. US, EU)")),
  ),
  account: optional(
    pipe(
      looseObject({
        name: pipe(string(), description("What --account accepts")),
        id: pipe(string(), description("Account ID")),
        email: optional(pipe(string(), description("Account email"))),
        username: optional(pipe(string(), description("Account username"))),
        server: optional(pipe(string(), description("Account server"))),
        host: optional(pipe(string(), description("Server origin"))),
        label: pipe(string(), description("Human-readable account label")),
        envVar: optional(
          pipe(string(), description("Variable providing the env token")),
        ),
      }),
      description("Account the org was listed under, across accounts"),
    ),
  ),
});

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
 * Table columns in display order: header → the entry's field, as a
 * `--fields` path (`account.name`).
 */
const ORG_LIST_COLUMNS: Record<string, string> = {
  SLUG: "slug",
  REGION: "region",
  NAME: "name",
  ACCOUNT: "account.name",
};

/** The string at `path` in `entry`, or `undefined` when unset. */
function cellOf(entry: OrgListEntry, path: string): string | undefined {
  const lookup = getNestedValue(entry, path);
  return lookup.found && typeof lookup.value === "string"
    ? lookup.value
    : undefined;
}

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
      ([header, path]) =>
        !OPTIONAL_ORG_LIST_COLUMNS.has(header) ||
        entries.some((e) => cellOf(e, path) !== undefined),
    )
    .map(([header, path]) => ({
      header,
      value: (e) => escapeMarkdownCell(cellOf(e, path) ?? ""),
    }));

  const parts: string[] = [];
  const buffer: Writer = { write: (s: string) => parts.push(s) };
  writeTable(buffer, entries, columns);

  return parts.join("").trimEnd();
}

function toOrgListAccount(account: AccountSummary): OrgListAccount {
  const optional = {
    email: account.email,
    username: account.username,
    server: accountServerOf(account),
    host: account.host,
    envVar: account.envVar,
  };
  const entry: OrgListAccount = {
    name: accountSelectorOf(account),
    id: account.id,
    label: formatAccountLabel(account),
  };
  for (const [field, value] of Object.entries(optional)) {
    if (value) {
      entry[field as keyof typeof optional] = value;
    }
  }
  return entry;
}

/** Fetch orgs (and their cached regions) with the credentials in effect. */
async function fetchOrgs(account?: AccountSummary): Promise<AccountOrgs> {
  const orgs = await listOrganizationsUncached();
  return { account, orgs, regions: getAllOrgRegions() };
}

/**
 * Fetch the env token's orgs with only the env token, on its own server,
 * and ask the server whose token it is (best-effort) to label it.
 */
async function fetchEnvAccountOrgs(
  account: AccountSummary,
): Promise<AccountOrgs> {
  const envAccount = getEnvAccount();
  if (!envAccount) {
    throw new AuthError(
      "not_authenticated",
      `${account.envVar ?? "The env token"} is no longer usable.`,
      { skipAutoAuth: true },
    );
  }
  const [fetched, user] = await Promise.all([
    withEnvAccount(envAccount, () => fetchOrgs()),
    fetchEnvAccountUser(envAccount),
  ]);
  return {
    ...fetched,
    account: toEnvAccountSummary(envAccount.envVar, envAccount.host, user),
  };
}

/** Fetch `account`'s orgs with its own credentials, on its own server. */
async function fetchAccountOrgs(account: AccountSummary): Promise<AccountOrgs> {
  if (account.envVar) {
    return await fetchEnvAccountOrgs(account);
  }
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
 * them (the env token, which org routing prefers, then the active
 * account, then the most recently used).
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
 * Which accounts to list: the one named by `--account`, else the env
 * token's virtual account (when its server is trusted, see
 * `getEnvAccount`) and every usable stored account in scope. `undefined`
 * means "the credentials in effect" (no usable account, only the active
 * one or only the env token, or a forced env token), which keeps the
 * single-account output unchanged. A single usable account that isn't the
 * active one (say, the active login was logged out) is listed with its own
 * credentials.
 */
function resolveAccounts(selector?: string): AccountSummary[] | undefined {
  if (selector !== undefined) {
    const envAccount = getEnvAccount();
    const envSummary = envAccount
      ? toEnvAccountSummary(envAccount.envVar, envAccount.host)
      : undefined;
    if (
      envSummary &&
      selector.trim().toLowerCase() === envSummary.id.toLowerCase()
    ) {
      return [envSummary];
    }
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
  // The env token, then the active account, then most recently used: an
  // org several of them share is listed under the one commands use for it.
  const stored = listUsableAccountsInScope()
    .map(toAccountSummary)
    .sort((a, b) => Number(b.active) - Number(a.active));
  const envAccount = getEnvAccountInScope();
  const accounts = envAccount
    ? [toEnvAccountSummary(envAccount.envVar, envAccount.host), ...stored]
    : stored;
  const [only] = accounts;
  return accounts.length > 1 || (only && !only.active && !only.envVar)
    ? accounts
    : undefined;
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
      "SENTRY_AUTH_TOKEN (or SENTRY_TOKEN) is listed as one more account,\n" +
      "env:SENTRY_AUTH_TOKEN, when its server is known: an organization auth\n" +
      "token's own URL, or sentry.io. Organizations it can access are listed\n" +
      "under it, and commands targeting them use it.\n" +
      "With SENTRY_FORCE_ENV_TOKEN=1, only the env token is used.\n\n" +
      "Pass a filter to only list organizations whose slug or name matches it,\n" +
      "ignoring case: exactly, as a prefix or substring, or with a small typo\n" +
      "(best matches first), or as a glob like 'acme-*'.\n\n" +
      "Alias: `sentry orgs` → `sentry org list`",
    examples: [
      { description: "List organizations", command: "sentry org list" },
      {
        description:
          "Only organizations whose slug or name matches (fuzzy, best matches first)",
        command: "sentry org list acme",
      },
      {
        description: "Only organizations matching a glob",
        command: "sentry org list 'acme-*'",
      },
      {
        description: "Only one account's organizations",
        command: "sentry org list --account jane@acme.com",
      },
      {
        description: "Same email on several servers: add the server",
        command: "sentry org list -a jane@example.com:sentry.io",
      },
      { description: "Output as JSON", command: "sentry org list --json" },
    ],
  },
  output: { human: formatOrgListHuman, schema: OrgListEntrySchema },
  parameters: {
    flags: {
      limit: buildListLimitFlag("organizations"),
      fresh: FRESH_FLAG,
      account: {
        kind: "parsed",
        parse: parseAccountSelector,
        brief:
          "Only list organizations of this account (email, username, or account id; <who>:<server> for one server; env:SENTRY_AUTH_TOKEN)",
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
          parse: parseOrgSlug,
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
    const orgs = filterByName(merged.orgs, filter, (org) => [
      org.slug,
      org.name,
    ]);
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
