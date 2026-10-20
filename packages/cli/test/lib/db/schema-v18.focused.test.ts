import { describe, expect, test } from "vitest";
import { listAccounts } from "../../../src/lib/db/accounts.js";
import { getAuthConfig } from "../../../src/lib/db/auth.js";
import {
  closeDatabase,
  getDatabase,
  getRawDatabase,
} from "../../../src/lib/db/index.js";
import {
  CURRENT_SCHEMA_VERSION,
  tableExists,
} from "../../../src/lib/db/schema.js";
import { getUserInfo } from "../../../src/lib/db/user.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("schema-v18-focused-");

/** Recreate the v17 single-row auth + user_info tables and reopen the DB. */
function downgradeToV17(rows: {
  auth?: { token: string; refresh: string | null; host: string | null };
  user?: { id: string; email: string | null; name: string | null };
}): void {
  const db = getDatabase();
  db.exec("DROP TABLE IF EXISTS accounts");
  db.exec(`CREATE TABLE auth (
    id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT, refresh_token TEXT,
    expires_at INTEGER, issued_at INTEGER,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), host TEXT
  )`);
  db.exec(`CREATE TABLE user_info (
    id INTEGER PRIMARY KEY CHECK (id = 1), user_id TEXT NOT NULL, email TEXT,
    username TEXT, name TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  )`);
  if (rows.auth) {
    db.query(
      "INSERT INTO auth (id, token, refresh_token, expires_at, issued_at, host) VALUES (1, ?, ?, ?, ?, ?)",
    ).run(
      rows.auth.token,
      rows.auth.refresh,
      Date.now() + 3_600_000,
      Date.now(),
      rows.auth.host,
    );
  }
  if (rows.user) {
    db.query(
      "INSERT INTO user_info (id, user_id, email, name) VALUES (1, ?, ?, ?)",
    ).run(rows.user.id, rows.user.email, rows.user.name);
  }
  db.query("UPDATE schema_version SET version = 17").run();
  closeDatabase();
}

describe("schema v18 multi-account migration", () => {
  test("folds the v17 login and user info into one active account", () => {
    downgradeToV17({
      auth: {
        token: "legacy-token",
        refresh: "legacy-refresh",
        host: "https://sentry.example.com",
      },
      user: { id: "7", email: "legacy@example.com", name: "Legacy" },
    });

    const db = getDatabase();
    expect(db.query("SELECT version FROM schema_version").get()).toEqual({
      version: CURRENT_SCHEMA_VERSION,
    });
    expect(tableExists(getRawDatabase(), "auth")).toBe(false);
    expect(tableExists(getRawDatabase(), "user_info")).toBe(false);

    const [account, ...rest] = listAccounts();
    expect(rest).toEqual([]);
    expect(account).toMatchObject({
      active: true,
      host: "https://sentry.example.com",
      userId: "7",
      email: "legacy@example.com",
      name: "Legacy",
      usable: true,
    });
    expect(getAuthConfig()).toMatchObject({
      token: "legacy-token",
      refreshToken: "legacy-refresh",
      source: "oauth",
    });
    expect(getUserInfo()?.userId).toBe("7");
  });

  test("keeps a pre-v16 NULL host for lazy backfill", () => {
    downgradeToV17({
      auth: { token: "legacy-token", refresh: null, host: null },
    });

    const [account] = listAccounts();
    expect(account?.host).toBeUndefined();
    expect(account?.userId).toBeUndefined();
  });

  test("drops a user_info row without credentials", () => {
    downgradeToV17({
      user: { id: "7", email: "orphan@example.com", name: null },
    });

    expect(listAccounts()).toEqual([]);
    expect(getUserInfo()).toBeUndefined();
  });
});
