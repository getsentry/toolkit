/**
 * Switching between CLI versions with different schemas (#1611).
 *
 * Covers a database last written by a newer CLI, and the hand-off
 * `sentry cli upgrade` performs before installing an older CLI.
 */

import { describe, expect, test } from "vitest";
import { listAccounts } from "../../../src/lib/db/accounts.js";
import {
  getAuthConfig,
  resetAuthRowCache,
  resetAuthTokenCache,
  setAuthToken,
} from "../../../src/lib/db/auth.js";
import {
  closeDatabase,
  getDatabase,
  getRawDatabase,
} from "../../../src/lib/db/index.js";
import {
  CURRENT_SCHEMA_VERSION,
  EXPECTED_TABLES,
  getSchemaIssues,
  prepareDatabaseForDowngrade,
  repairSchema,
  tableExists,
} from "../../../src/lib/db/schema.js";
import { setUserInfo } from "../../../src/lib/db/user.js";
import { useEnvSandbox, useTestConfigDir } from "../../helpers.js";

useTestConfigDir("schema-downgrade-");
useEnvSandbox([
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_CLI_NO_AUTO_REPAIR",
  "SENTRY_HOST",
  "SENTRY_URL",
]);

const HOST = "https://sentry.io";

/** `org_regions` as CLI 0.47.0 (schema 16) creates and upserts it. */
const V16_ORG_REGIONS_DDL = `CREATE TABLE IF NOT EXISTS org_regions (
  org_slug TEXT PRIMARY KEY, org_id TEXT, org_name TEXT, org_role TEXT,
  region_url TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
)`;
/** `auth` as CLI 0.47.0 creates it. */
const V16_AUTH_DDL = `CREATE TABLE IF NOT EXISTS auth (
  id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT, refresh_token TEXT,
  expires_at INTEGER, issued_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000), host TEXT
)`;
const V16_ORG_REGIONS_UPSERT = `INSERT INTO org_regions (org_slug, region_url)
  VALUES ('acme', 'https://us.sentry.io')
  ON CONFLICT(org_slug) DO UPDATE SET region_url = excluded.region_url`;

function storedVersion(): number {
  const row = getRawDatabase()
    .query("SELECT version FROM schema_version")
    .get() as { version: number };
  return row.version;
}

function reopen(): void {
  closeDatabase();
  resetAuthTokenCache();
  resetAuthRowCache();
  getDatabase();
}

function primaryKey(table: string): string[] {
  return (
    getRawDatabase()
      .query(
        `SELECT name FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

/** Leave the DB as a newer CLI would: a changed cache key, a higher version. */
function writeAsNewerCli(): void {
  const db = getRawDatabase();
  db.exec("DROP TABLE org_regions");
  db.exec(V16_ORG_REGIONS_DDL);
  db.exec(V16_ORG_REGIONS_UPSERT);
  db.query("UPDATE schema_version SET version = ?").run(
    CURRENT_SCHEMA_VERSION + 1,
  );
}

describe("database written by a newer CLI", () => {
  test("rebuilds caches, keeps the login, and records this version", () => {
    setAuthToken("newer-token", undefined, undefined, { host: HOST });
    writeAsNewerCli();

    reopen();

    expect(storedVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(primaryKey("org_regions")).toEqual([
      "credential_identity",
      "source_origin",
      "org_slug",
    ]);
    expect(
      getRawDatabase().query("SELECT COUNT(*) AS n FROM org_regions").get(),
    ).toEqual({ n: 0 });
    expect(getAuthConfig()?.token).toBe("newer-token");
    expect(getSchemaIssues(getRawDatabase())).toEqual([]);
  });

  test("only reports the mismatch when auto-repair is disabled", () => {
    writeAsNewerCli();
    process.env.SENTRY_CLI_NO_AUTO_REPAIR = "1";

    reopen();

    expect(storedVersion()).toBe(CURRENT_SCHEMA_VERSION + 1);
    expect(getSchemaIssues(getRawDatabase())).toEqual(
      expect.arrayContaining([
        { type: "newer_schema", version: CURRENT_SCHEMA_VERSION + 1 },
        { type: "wrong_primary_key", table: "org_regions" },
      ]),
    );

    const result = repairSchema(getRawDatabase());
    expect(result.failed).toEqual([]);
    expect(storedVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(getSchemaIssues(getRawDatabase())).toEqual([]);
  });
});

describe("repairSchema: primary keys", () => {
  test("recreates a cache table whose single-column key differs", () => {
    const db = getRawDatabase();
    db.exec("DROP TABLE org_regions");
    db.exec(V16_ORG_REGIONS_DDL);

    expect(getSchemaIssues(db)).toContainEqual({
      type: "wrong_primary_key",
      table: "org_regions",
    });
    const result = repairSchema(db);

    expect(result.failed).toEqual([]);
    expect(primaryKey("org_regions")).toEqual([
      "credential_identity",
      "source_origin",
      "org_slug",
    ]);
  });

  test("reports instead of dropping a table it cannot rebuild", () => {
    const db = getRawDatabase();
    db.exec("DROP TABLE instance_info");
    db.exec(
      "CREATE TABLE instance_info (id INTEGER NOT NULL, instance_id TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (id, instance_id))",
    );
    db.exec("INSERT INTO instance_info (id, instance_id) VALUES (1, 'keep')");

    const result = repairSchema(db);

    expect(result.failed).toEqual([
      "Table instance_info has an unexpected primary key and holds data that cannot be rebuilt",
    ]);
    expect(db.query("SELECT instance_id FROM instance_info").get()).toEqual({
      instance_id: "keep",
    });
  });
});

describe("prepareDatabaseForDowngrade", () => {
  test("leaves a database CLI 0.47.0 can use, logged out", () => {
    setAuthToken("active-token", 3600, "active-refresh", { host: HOST });
    setUserInfo({ userId: "7", email: "dev@example.com", name: "Dev" });
    const db = getRawDatabase();

    prepareDatabaseForDowngrade(db);

    expect(storedVersion()).toBe(16);
    expect(tableExists(db, "org_regions")).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM accounts").get()).toEqual({
      n: 0,
    });
    // What 0.47.0 does on startup and when listing organizations.
    db.exec(V16_ORG_REGIONS_DDL);
    expect(() => db.exec(V16_ORG_REGIONS_UPSERT)).not.toThrow();
  });

  test("picks up a login made in the older CLI on the way back up", () => {
    setAuthToken("active-token", 3600, "active-refresh", { host: HOST });
    const db = getRawDatabase();
    prepareDatabaseForDowngrade(db);
    // 0.47.0 recreates its tables, then the user logs in there.
    db.exec(V16_ORG_REGIONS_DDL);
    db.exec(V16_ORG_REGIONS_UPSERT);
    db.exec(V16_AUTH_DDL);
    db.query(
      "INSERT INTO auth (id, token, refresh_token, host) VALUES (1, 'older-cli-token', 'older-cli-refresh', ?)",
    ).run(HOST);

    reopen();

    expect(storedVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(tableExists(getRawDatabase(), "auth")).toBe(false);
    expect(primaryKey("org_regions")).toEqual([
      "credential_identity",
      "source_origin",
      "org_slug",
    ]);
    expect(listAccounts()).toHaveLength(1);
    expect(getAuthConfig()).toMatchObject({
      token: "older-cli-token",
      refreshToken: "older-cli-refresh",
    });
  });

  test("redoes the hand-off after another invocation re-migrated", () => {
    const db = getRawDatabase();
    prepareDatabaseForDowngrade(db);
    // Another newer-CLI invocation during the download.
    reopen();
    expect(storedVersion()).toBe(CURRENT_SCHEMA_VERSION);

    prepareDatabaseForDowngrade(getRawDatabase());

    expect(storedVersion()).toBe(16);
    expect(tableExists(getRawDatabase(), "org_regions")).toBe(false);
  });

  test("keeps migrations the older CLI ran when run again", () => {
    const db = getRawDatabase();
    prepareDatabaseForDowngrade(db);
    // An older CLI between schema 16 and this one migrates forward on setup.
    db.exec(EXPECTED_TABLES.org_regions as string);
    db.query("UPDATE schema_version SET version = ?").run(
      CURRENT_SCHEMA_VERSION - 1,
    );

    prepareDatabaseForDowngrade(db);

    expect(storedVersion()).toBe(CURRENT_SCHEMA_VERSION - 1);
    expect(tableExists(db, "org_regions")).toBe(true);
  });
});
