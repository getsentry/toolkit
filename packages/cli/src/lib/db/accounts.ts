/**
 * Stored Sentry accounts (multi-account storage).
 *
 * Each `sentry auth login` stores one row in the `accounts` table. Exactly
 * one row is active; credential reads in `auth.ts` target it. This module
 * owns raw row access and display helpers. Mutations that change which
 * credential is active go through `auth.ts` so its memoized state resets.
 */

import { createHash } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { getDatabase } from "./index.js";

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
};

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
        issued_at, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      accountId,
      values.host,
      values.token,
      values.refresh_token,
      values.expires_at,
      values.issued_at,
      now,
      now,
    );
  })();
  return accountId;
}

/** Mark one account active and every other account inactive. */
export function activateAccountRow(accountId: string): void {
  const db = getDatabase();
  db.transaction(() => {
    db.query("UPDATE accounts SET is_active = 0 WHERE is_active = 1").run();
    db.query("UPDATE accounts SET is_active = 1 WHERE account_id = ?").run(
      accountId,
    );
  })();
}

/**
 * Stable SHA-256 namespace for high-entropy OAuth and organization tokens.
 * A collision would mix credentials' cached responses, so retain the full
 * digest. This fingerprint is never a password verifier or a bearer token.
 */
export function hashIdentity(kind: string, secret: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(secret)
    .digest("hex");
}

/** Cache namespace for a stored account (matches `getIdentityFingerprint`). */
export function accountIdentity(row: AccountRow): string | undefined {
  if (row.refresh_token) {
    return hashIdentity("oauth", row.refresh_token);
  }
  if (row.token) {
    return hashIdentity("oauth-access", row.token);
  }
  return;
}

/** True when the row's credential is usable now or can be refreshed. */
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
      const identity = accountIdentity(row);
      if (identity) {
        db.query("DELETE FROM org_regions WHERE credential_identity = ?").run(
          identity,
        );
      }
      db.query("DELETE FROM accounts WHERE account_id = ?").run(row.account_id);
    }
  })();
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
 * Find stored accounts matching a user-supplied selector.
 *
 * Matches, in order of precedence: exact account id, then case-insensitive
 * email, username, or user id. A selector of the form `<who>@<host>` where
 * `<host>` matches the account's hostname narrows by server as well.
 * Returns every match so callers can report ambiguity.
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

function matchesIdentity(account: AccountSummary, needle: string): boolean {
  return [account.email, account.username, account.userId].some(
    (value) => value?.toLowerCase() === needle,
  );
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
