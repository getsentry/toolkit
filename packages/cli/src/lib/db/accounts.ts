/**
 * Stored Sentry accounts (multi-account storage).
 *
 * Each `sentry auth login` stores one row in the `accounts` table. Exactly
 * one row is active; credential reads in `auth.ts` target it. This module
 * owns raw row access and display helpers. Mutations that change which
 * credential is active go through `auth.ts` so its memoized state resets.
 */

import { isSaaSTrustOrigin } from "@sentry/toolkit-core/sentry-origin";
import { uuidv7 } from "uuidv7";
import { normalizeUrl } from "../constants.js";
import { fuzzyMatch } from "../fuzzy.js";
import { normalizeHttpOrigin } from "../sentry-urls.js";
import { storedCredentialIdentity } from "./identity-hash.js";
import { getDatabase } from "./index.js";
import { ORG_CACHE_TTL_MS } from "./regions.js";

/** Raw `accounts` row. */
export type AccountRow = {
  account_id: string;
  host: string | null;
  user_id: string | null;
  email: string | null;
  username: string | null;
  name: string | null;
  token: string | null;
  refresh_token: string | null;
  expires_at: number | null;
  issued_at: number | null;
  is_active: number;
  created_at: number;
  updated_at: number;
  last_used_at: number;
};

/** Public, secret-free view of a stored account. */
export type AccountSummary = {
  id: string;
  active: boolean;
  host: string | undefined;
  userId: string | undefined;
  email: string | undefined;
  username: string | undefined;
  name: string | undefined;
  /** Whether the stored credential can still be used (or refreshed). */
  usable: boolean;
  expiresAt: number | undefined;
  /**
   * Set for the virtual account of an env token (`SENTRY_AUTH_TOKEN` or
   * `SENTRY_TOKEN`), which is never stored: the variable providing it.
   */
  envVar?: string;
};

/** Prefix of an env token's virtual account id, e.g. `env:SENTRY_AUTH_TOKEN`. */
export const ENV_ACCOUNT_ID_PREFIX = "env:";

/**
 * Secret-free summary of an env token's virtual account on `host`, with the
 * token's user when known (from `/auth/`). Never active: `sentry auth
 * switch` only selects stored accounts.
 */
export function toEnvAccountSummary(
  envVar: string,
  host: string,
  user?: {
    id?: string;
    email?: string | null;
    username?: string | null;
    name?: string | null;
  },
): AccountSummary {
  return {
    id: `${ENV_ACCOUNT_ID_PREFIX}${envVar}`,
    active: false,
    host,
    userId: user?.id || undefined,
    email: user?.email || undefined,
    username: user?.username || undefined,
    name: user?.name || undefined,
    usable: true,
    expiresAt: undefined,
    envVar,
  };
}

/** Read the active account row. Returns `undefined` when none is active. */
export function getActiveAccountRow(): AccountRow | undefined {
  const db = getDatabase();
  return db
    .query(
      "SELECT * FROM accounts WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1",
    )
    .get() as AccountRow | undefined;
}

/** Read one account row by id. */
export function getAccountRow(accountId: string): AccountRow | undefined {
  const db = getDatabase();
  return db
    .query("SELECT * FROM accounts WHERE account_id = ?")
    .get(accountId) as AccountRow | undefined;
}

/** List all stored account rows, oldest login first. */
export function listAccountRows(): AccountRow[] {
  const db = getDatabase();
  return db
    .query("SELECT * FROM accounts ORDER BY created_at ASC, account_id ASC")
    .all() as AccountRow[];
}

/** Insert a new account row and make it the only active one. */
export function insertActiveAccountRow(
  values: Pick<
    AccountRow,
    "host" | "token" | "refresh_token" | "expires_at" | "issued_at"
  >,
  now: number,
): string {
  const db = getDatabase();
  const accountId = uuidv7();
  db.transaction(() => {
    db.query("UPDATE accounts SET is_active = 0 WHERE is_active = 1").run();
    db.query(
      `INSERT INTO accounts (account_id, host, token, refresh_token, expires_at,
        issued_at, is_active, created_at, updated_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      accountId,
      values.host,
      values.token,
      values.refresh_token,
      values.expires_at,
      values.issued_at,
      now,
      now,
      now,
    );
  })();
  return accountId;
}

/**
 * Mark one account active and every other account inactive, recording when
 * it was last used. `updated_at` is left alone: it versions the stored
 * credential for refresh compare-and-swap.
 */
export function activateAccountRow(accountId: string): void {
  const db = getDatabase();
  db.transaction(() => {
    db.query("UPDATE accounts SET is_active = 0 WHERE is_active = 1").run();
    db.query(
      "UPDATE accounts SET is_active = 1, last_used_at = ? WHERE account_id = ?",
    ).run(Date.now(), accountId);
  })();
}

/** Cache namespace for a stored account (matches `getIdentityFingerprint`). */
export function accountIdentity(row: AccountRow): string | undefined {
  return storedCredentialIdentity(row);
}

/**
 * True when the row's credential is usable now or can be refreshed.
 * `USABLE_ACCOUNT_SQL` is the query form; keep the two in sync.
 */
export function isAccountRowUsable(row: AccountRow): boolean {
  if (!row.token) {
    return false;
  }
  return !row.expires_at || Date.now() <= row.expires_at || !!row.refresh_token;
}

/**
 * Delete account rows plus their identity-scoped region cache entries.
 * Callers decide whether a new active account is needed afterwards.
 */
export function deleteAccountRows(rows: readonly AccountRow[]): void {
  if (rows.length === 0) {
    return;
  }
  const db = getDatabase();
  db.transaction(() => {
    for (const row of rows) {
      deleteAccountOrgRegions(row);
      db.query("DELETE FROM accounts WHERE account_id = ?").run(row.account_id);
    }
  })();
}

/**
 * Delete an account's cached org memberships: rows keyed by its current
 * credential identity, and rows recorded against the account under an
 * earlier identity (before a refresh-token rotation or re-login).
 */
export function deleteAccountOrgRegions(row: AccountRow): void {
  const db = getDatabase();
  const identity = accountIdentity(row);
  if (identity) {
    db.query("DELETE FROM org_regions WHERE credential_identity = ?").run(
      identity,
    );
  }
  db.query("DELETE FROM org_regions WHERE account_id = ?").run(row.account_id);
}

/** Convert a row into its secret-free summary. */
export function toAccountSummary(row: AccountRow): AccountSummary {
  return {
    id: row.account_id,
    active: row.is_active === 1,
    host: row.host ?? undefined,
    userId: row.user_id ?? undefined,
    email: row.email ?? undefined,
    username: row.username ?? undefined,
    name: row.name ?? undefined,
    usable: isAccountRowUsable(row),
    expiresAt: row.expires_at ?? undefined,
  };
}

/** List every stored account without secrets. */
export function listAccounts(): AccountSummary[] {
  return listAccountRows().map(toAccountSummary);
}

/**
 * Split a `<who>[:<server>]` account selector (e.g.
 * `jane@acme.com:sentry.acme.com`) on its first `:`. Emails, usernames, and
 * account ids never contain one, so everything after it is the server: a
 * bare host (HTTPS, may include a port) or a URL. Shared by `--account`,
 * `auth switch`/`logout`, and `auth login`.
 *
 * @returns `{ who }` without a `:`; `{ who, server }` with the server's
 *   normalized origin; `undefined` when a side of the `:` is empty or the
 *   server is not an HTTP(S) URL
 */
export function splitAccountSelector(
  selector: string,
): { who: string; server?: string } | undefined {
  const trimmed = selector.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) {
    return { who: trimmed };
  }
  const who = trimmed.slice(0, colon);
  const server = normalizeHttpOrigin(normalizeUrl(trimmed.slice(colon + 1)));
  return who && server ? { who, server } : undefined;
}

/**
 * The `<who>:<server>` selector naming an account, e.g.
 * `jane@acme.com:sentry.acme.com`: what `--account` and
 * `sentry auth login` accept. Uses the email, else the username, else the
 * account id; the server part is omitted when no host is recorded. An env
 * token's account is named by its id (`env:SENTRY_AUTH_TOKEN`).
 */
export function accountSelectorOf(account: AccountSummary): string {
  if (account.envVar) {
    return account.id;
  }
  const who = account.email ?? account.username ?? account.id;
  const server = accountServerOf(account);
  return server ? `${who}:${server}` : who;
}

/**
 * The server part of an account's selector: `host[:port]` for HTTPS, the
 * full origin (`http://host[:port]`) otherwise, since selector parsing
 * assumes HTTPS for a bare host. `undefined` when no host is recorded.
 */
export function accountServerOf(account: {
  readonly host?: string;
}): string | undefined {
  const host = account.host;
  const origin = normalizeHttpOrigin(host);
  if (!origin) {
    return hostnameOf(host);
  }
  const url = new URL(origin);
  return url.protocol === "https:" ? url.host : origin;
}

/**
 * Find stored accounts matching a user-supplied selector.
 *
 * Matches, in order of precedence: exact account id, then case-insensitive
 * email, username, or user id. A selector of the form `<who>:<server>`
 * (see {@link accountSelectorOf}) or `<who>@<hostname>` narrows by server
 * as well. Returns every match so callers can report ambiguity.
 */
export function findAccounts(selector: string): AccountSummary[] {
  const accounts = listAccounts();
  const byId = accounts.filter((a) => a.id === selector);
  if (byId.length > 0) {
    return byId;
  }
  const needle = selector.trim().toLowerCase();
  const direct = accounts.filter((a) => matchesIdentity(a, needle));
  if (direct.length > 0) {
    return direct;
  }
  const parts = splitAccountSelector(needle);
  const server = parts?.server;
  if (parts && server) {
    return accounts.filter(
      (a) => matchesIdentity(a, parts.who) && isAccountOnServer(a, server),
    );
  }
  const at = needle.lastIndexOf("@");
  if (at <= 0) {
    return [];
  }
  const who = needle.slice(0, at);
  const host = needle.slice(at + 1);
  return accounts.filter(
    (a) => matchesIdentity(a, who) && hostnameOf(a.host) === host,
  );
}

/**
 * Stored accounts whose email, username, or name resembles `selector`,
 * ranked by the shared {@link fuzzyMatch} matcher (prefix, substring, then
 * small typos). Used when {@link findAccounts} has no exact match, to
 * suggest — or, for non-destructive commands, pick — the intended account.
 */
export function findSimilarAccounts(
  selector: string,
  maxResults = 5,
): AccountSummary[] {
  const needle = selector.trim();
  if (!needle) {
    return [];
  }
  const byValue = new Map<string, AccountSummary[]>();
  for (const account of listAccounts()) {
    const host = hostnameOf(account.host);
    const values = [
      account.email,
      account.username,
      account.name,
      account.email && host ? `${account.email}@${host}` : undefined,
      account.host ? accountSelectorOf(account) : undefined,
    ];
    for (const value of values) {
      if (value) {
        byValue.set(value, [...(byValue.get(value) ?? []), account]);
      }
    }
  }
  const ranked: AccountSummary[] = [];
  for (const value of fuzzyMatch(needle, [...byValue.keys()])) {
    for (const account of byValue.get(value) ?? []) {
      if (!ranked.some((a) => a.id === account.id)) {
        ranked.push(account);
      }
    }
  }
  return ranked.slice(0, maxResults);
}

function matchesIdentity(account: AccountSummary, needle: string): boolean {
  return [account.email, account.username, account.userId].some(
    (value) => value?.toLowerCase() === needle,
  );
}

/**
 * Whether an account's stored host is the given server: the same origin,
 * or both SaaS (`*.sentry.io`). `false` for an account without a host.
 */
export function isAccountOnServer(
  account: { readonly host?: string | null },
  url: string,
): boolean {
  return account.host ? isSameServer(account.host, url) : false;
}

/** Hostname of a stored account origin, lowercased. */
export function hostnameOf(host: string | undefined): string | undefined {
  if (!host) {
    return;
  }
  return URL.canParse(host)
    ? new URL(host).hostname.toLowerCase()
    : host.toLowerCase();
}

/**
 * Whether two server URLs belong to the same Sentry installation: the same
 * origin, or both SaaS (`*.sentry.io`). Mirrors the token trust model in
 * `token-host.ts`, so an account is only ever chosen for hosts its token
 * is already allowed to reach.
 */
export function isSameServer(a: string, b: string): boolean {
  const left = serverKey(a);
  return left !== undefined && left === serverKey(b);
}

/** Every SaaS origin (`*.sentry.io`) shares one {@link serverKey}. */
const SAAS_SERVER_KEY = "saas";

/**
 * Canonical key for a server URL: equal for exactly the URLs
 * {@link isSameServer} treats as one installation (the same origin, or any
 * SaaS origin), so it can key a `Set` or `Map`. `undefined` for a URL that
 * isn't a credential-free HTTP(S) origin.
 */
export function serverKey(url: string): string | undefined {
  const origin = normalizeHttpOrigin(url);
  if (!origin) {
    return;
  }
  return isSaaSTrustOrigin(origin) ? SAAS_SERVER_KEY : origin;
}

/**
 * Most recently used first. Ties (same `last_used_at`) fall back to the
 * latest update, then to creation order, so picks are deterministic.
 */
const BY_RECENCY =
  "ORDER BY last_used_at DESC, updated_at DESC, created_at ASC, account_id ASC";

/**
 * SQL form of {@link isAccountRowUsable}: a token that is unexpired,
 * never expires, or can be refreshed. Bind `Date.now()` as its only
 * parameter. Keep the two in sync.
 */
const USABLE_ACCOUNT_SQL = `token IS NOT NULL AND token != ''
  AND (expires_at IS NULL OR expires_at = 0 OR expires_at >= ?
    OR (refresh_token IS NOT NULL AND refresh_token != ''))`;

/** The most recently used stored account, usable or not. */
export function getMostRecentAccountRow(): AccountRow | undefined {
  return (
    (getDatabase()
      .query(`SELECT * FROM accounts ${BY_RECENCY} LIMIT 1`)
      .get() as AccountRow | null) ?? undefined
  );
}

/** All stored accounts, usable or not, most recently used first. */
export function listAccountRowsByRecency(): AccountRow[] {
  return getDatabase()
    .query(`SELECT * FROM accounts ${BY_RECENCY}`)
    .all() as AccountRow[];
}

/** Usable stored accounts, most recently used first. */
export function listUsableAccountRowsByRecency(): AccountRow[] {
  return getDatabase()
    .query(`SELECT * FROM accounts WHERE ${USABLE_ACCOUNT_SQL} ${BY_RECENCY}`)
    .all(Date.now()) as AccountRow[];
}

/**
 * Usable stored accounts that have seen an organization, by slug or
 * numeric id, most recently used first — the first row is the pick.
 *
 * Org membership is already cached per account: `org_regions.account_id`
 * is recorded whenever an account resolves or lists an organization, so
 * this is one query over that cache rather than a lookup per account.
 *
 * Resolving one org by slug caches no numeric id (only org lists do), so a
 * numeric id also matches rows for the slug that any cached row on the
 * same server maps that id to.
 */
export function listUsableAccountRowsForOrg(
  orgSlug: string,
  orgId?: string,
): AccountRow[] {
  const id = orgId ?? null;
  return getDatabase()
    .query(
      `SELECT * FROM accounts
       WHERE account_id IN (
         SELECT r.account_id FROM org_regions r
         WHERE r.account_id IS NOT NULL AND (
           r.org_slug = ? OR r.org_id = ? OR EXISTS (
             SELECT 1 FROM org_regions m
             WHERE m.org_id = ? AND m.org_slug = r.org_slug
               AND m.source_origin = r.source_origin
           )
         )
       ) AND ${USABLE_ACCOUNT_SQL}
       ${BY_RECENCY}`,
    )
    .all(orgSlug, id, id, Date.now()) as AccountRow[];
}

/**
 * Whether a fresh full organization list is cached for an account (rows
 * written by `listOrganizations`, which carry the numeric org id, updated
 * within {@link ORG_CACHE_TTL_MS} — the TTL `getCachedOrganizations` uses).
 * Only then can an org's absence mean the account is not a member; an
 * expired list may predate a new membership.
 */
export function hasCachedOrgList(accountId: string): boolean {
  const row = getDatabase()
    .query(
      "SELECT 1 AS found FROM org_regions WHERE account_id = ? AND org_id IS NOT NULL AND updated_at > ? LIMIT 1",
    )
    .get(accountId, Date.now() - ORG_CACHE_TTL_MS) as
    | { found: number }
    | null
    | undefined;
  return Boolean(row);
}

/**
 * Whether the org cache shows `identity` (a credential fingerprint, see
 * `getIdentityFingerprint`) has seen an organization on `host`'s server, by
 * slug or numeric id. Mirrors {@link listUsableAccountRowsForOrg} for a
 * credential that is not a stored account: the env token. Its fingerprint
 * doesn't depend on the server, so rows cached while it was scoped to
 * another server (a different `SENTRY_URL`) must not count: that server's
 * org with the same slug is a different org.
 */
export function hasCachedOrgForIdentity(
  identity: string,
  host: string,
  orgSlug: string,
  orgId?: string,
): boolean {
  const server = serverKey(host);
  if (!server) {
    return false;
  }
  // `source_origin` holds normalized origins: every SaaS origin is one
  // server (as in `serverKey`), anything else must match exactly.
  const saas = server === SAAS_SERVER_KEY;
  const sameServer = saas
    ? "(r.source_origin = 'https://sentry.io' OR r.source_origin LIKE 'https://%.sentry.io')"
    : "r.source_origin = ?";
  const id = orgId ?? null;
  const row = getDatabase()
    .query(
      `SELECT 1 FROM org_regions r
       WHERE r.credential_identity = ? AND ${sameServer} AND (
         r.org_slug = ? OR r.org_id = ? OR EXISTS (
           SELECT 1 FROM org_regions m
           WHERE m.org_id = ? AND m.org_slug = r.org_slug
             AND m.source_origin = r.source_origin
         )
       )
       LIMIT 1`,
    )
    .get(identity, ...(saas ? [] : [server]), orgSlug, id, id);
  return Boolean(row);
}
