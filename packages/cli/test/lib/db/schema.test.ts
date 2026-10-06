/**
 * Tests for database schema repair functions.
 */

import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  EXPECTED_COLUMNS,
  EXPECTED_TABLES,
  generatePreMigrationTableDDL,
  getSchemaIssues,
  hasColumn,
  initSchema,
  isReadonlyError,
  repairSchema,
  runMigrations,
  tableExists,
} from "../../../src/lib/db/schema.js";
import { Database } from "../../../src/lib/db/sqlite.js";
import { getMetadata } from "../../../src/lib/db/utils.js";
import { useTestConfigDir } from "../../helpers.js";

/**
 * Create a database with all tables but some missing (for testing repair).
 */
function createDatabaseWithMissingTables(
  db: Database,
  missingTables: string[]
): void {
  const statements: string[] = [];
  for (const tableName of Object.keys(EXPECTED_TABLES)) {
    if (missingTables.includes(tableName)) continue;
    statements.push(EXPECTED_TABLES[tableName] as string);
  }
  db.exec(statements.join(";\n"));
  db.query("INSERT INTO schema_version (version) VALUES (?)").run(
    CURRENT_SCHEMA_VERSION
  );
}

/**
 * Create a database with pre-migration versions of specified tables.
 * Tables with migrated columns will be created without those columns.
 */
function createPreMigrationDatabase(
  db: Database,
  preMigrationTables: string[]
): void {
  const statements: string[] = [];
  for (const tableName of Object.keys(EXPECTED_TABLES)) {
    if (preMigrationTables.includes(tableName)) {
      statements.push(generatePreMigrationTableDDL(tableName));
    } else {
      statements.push(EXPECTED_TABLES[tableName] as string);
    }
  }
  db.exec(statements.join(";\n"));
  db.query("INSERT INTO schema_version (version) VALUES (?)").run(
    CURRENT_SCHEMA_VERSION
  );
}

const getTestDir = useTestConfigDir("schema-test-");

describe("tableExists", () => {
  test("returns true for existing table", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    db.exec("CREATE TABLE test_table (id INTEGER PRIMARY KEY)");

    expect(tableExists(db, "test_table")).toBe(true);
    db.close();
  });

  test("returns false for non-existent table", () => {
    const db = new Database(join(getTestDir(), "test.db"));

    expect(tableExists(db, "nonexistent")).toBe(false);
    db.close();
  });
});

describe("hasColumn", () => {
  test("returns true for existing column", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    db.exec("CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT)");

    expect(hasColumn(db, "test_table", "id")).toBe(true);
    expect(hasColumn(db, "test_table", "name")).toBe(true);
    db.close();
  });

  test("returns false for non-existent column", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    db.exec("CREATE TABLE test_table (id INTEGER PRIMARY KEY)");

    expect(hasColumn(db, "test_table", "missing_column")).toBe(false);
    db.close();
  });
});

describe("getSchemaIssues", () => {
  test("returns empty array for healthy database", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);

    const issues = getSchemaIssues(db);
    expect(issues).toEqual([]);
    db.close();
  });

  test("detects missing table", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    // Create schema without dsn_cache using the helper
    createDatabaseWithMissingTables(db, ["dsn_cache"]);

    const issues = getSchemaIssues(db);
    const missingTables = issues.filter((i) => i.type === "missing_table");

    expect(missingTables).toContainEqual({
      type: "missing_table",
      table: "dsn_cache",
    });
    db.close();
  });

  test("detects missing column", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    // Create dsn_cache without v4 columns (pre-migration state)
    createPreMigrationDatabase(db, ["dsn_cache"]);

    const issues = getSchemaIssues(db);
    const missingColumns = issues.filter((i) => i.type === "missing_column");

    // Should detect all v4 columns are missing from dsn_cache
    expect(missingColumns).toContainEqual({
      type: "missing_column",
      table: "dsn_cache",
      column: "fingerprint",
    });
    expect(missingColumns).toContainEqual({
      type: "missing_column",
      table: "dsn_cache",
      column: "dir_mtimes_json",
    });
    db.close();
  });
});

describe("repairSchema", () => {
  test("creates missing tables", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(1);

    // Verify table is missing
    expect(tableExists(db, "dsn_cache")).toBe(false);

    const result = repairSchema(db);

    // Should have created the table
    expect(tableExists(db, "dsn_cache")).toBe(true);
    expect(
      result.fixed.some((f) => f.includes("Created table dsn_cache"))
    ).toBe(true);
    expect(result.failed).toEqual([]);
    db.close();
  });

  test("adds missing columns", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);

    // Remove migrated columns by recreating the table in pre-migration state
    db.exec("DROP TABLE dsn_cache");
    db.exec(generatePreMigrationTableDDL("dsn_cache"));

    // Verify column is missing
    expect(hasColumn(db, "dsn_cache", "fingerprint")).toBe(false);
    expect(hasColumn(db, "dsn_cache", "dir_mtimes_json")).toBe(false);

    const result = repairSchema(db);

    // Should have added the columns
    expect(hasColumn(db, "dsn_cache", "fingerprint")).toBe(true);
    expect(hasColumn(db, "dsn_cache", "dir_mtimes_json")).toBe(true);
    expect(result.fixed.some((f) => f.includes("dsn_cache.fingerprint"))).toBe(
      true
    );
    expect(result.failed).toEqual([]);
    db.close();
  });

  test("returns empty result for healthy database", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);

    const result = repairSchema(db);

    expect(result.fixed).toEqual([]);
    expect(result.failed).toEqual([]);
    db.close();
  });

  test("updates schema version after repair", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    db.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    db.query("INSERT INTO schema_version (version) VALUES (?)").run(1);

    repairSchema(db);

    const version = (
      db.query("SELECT version FROM schema_version").get() as {
        version: number;
      }
    ).version;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});

describe("EXPECTED_TABLES", () => {
  test("contains all required tables", () => {
    const expectedTableNames = [
      "schema_version",
      "auth",
      "project_cache",
      "dsn_cache",
      "project_aliases",
      "metadata",
      "org_regions",
      "user_info",
      "instance_info",
      "project_root_cache",
      "pagination_cursors",
    ];

    for (const table of expectedTableNames) {
      expect(EXPECTED_TABLES).toHaveProperty(table);
    }
  });
});

describe("EXPECTED_COLUMNS", () => {
  test("dsn_cache includes v4 columns", () => {
    const dsnCacheColumns = EXPECTED_COLUMNS.dsn_cache;
    const columnNames = dsnCacheColumns?.map((c) => c.name) ?? [];

    expect(columnNames).toContain("fingerprint");
    expect(columnNames).toContain("all_dsns_json");
    expect(columnNames).toContain("source_mtimes_json");
    expect(columnNames).toContain("dir_mtimes_json");
    expect(columnNames).toContain("root_dir_mtime");
    expect(columnNames).toContain("ttl_expires_at");
  });

  test("user_info includes v3 column", () => {
    const userInfoColumns = EXPECTED_COLUMNS.user_info;
    const columnNames = userInfoColumns?.map((c) => c.name) ?? [];

    expect(columnNames).toContain("name");
  });
});

describe("isReadonlyError", () => {
  test("returns true for SQLiteError with readonly message", () => {
    const error = new Error("attempt to write a readonly database");
    error.name = "SQLiteError";
    expect(isReadonlyError(error)).toBe(true);
  });

  test("returns true for mixed-case readonly message", () => {
    const error = new Error("Attempt to Write a Readonly Database");
    error.name = "SQLiteError";
    expect(isReadonlyError(error)).toBe(true);
  });

  test("returns false for schema errors", () => {
    const error = new Error("no such table: foo");
    error.name = "SQLiteError";
    expect(isReadonlyError(error)).toBe(false);
  });

  test("returns true for plain Error with readonly message", () => {
    // node:sqlite throws plain Error (not SQLiteError) — the check
    // must match by message content to work across runtimes.
    const error = new Error("attempt to write a readonly database");
    expect(isReadonlyError(error)).toBe(true);
  });

  test("returns false for non-Error values", () => {
    expect(isReadonlyError("attempt to write a readonly database")).toBe(false);
    expect(isReadonlyError(null)).toBe(false);
    expect(isReadonlyError(undefined)).toBe(false);
  });
});

describe("runMigrations", () => {
  test("no-op when already at current version", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);

    // Should not throw and version stays at current
    runMigrations(db);

    const version = (
      db.query("SELECT version FROM schema_version").get() as {
        version: number;
      }
    ).version;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  test("repairs pagination_cursors with wrong single-column PK (CLI-72)", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    // Build a full schema but with the bugged pagination_cursors table
    initSchema(db);
    db.exec("DROP TABLE pagination_cursors");
    db.exec(
      "CREATE TABLE pagination_cursors (command_key TEXT PRIMARY KEY, context TEXT NOT NULL, cursor TEXT NOT NULL, expires_at INTEGER NOT NULL)"
    );
    // Set version to 5 so migration 5→6 fires
    db.query("UPDATE schema_version SET version = 5").run();

    runMigrations(db);

    // Table should now have the correct composite PK
    const row = db
      .query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='pagination_cursors'"
      )
      .get() as { sql: string };
    expect(row.sql).toContain("PRIMARY KEY (command_key, context)");

    // Version should be bumped to 6
    const version = (
      db.query("SELECT version FROM schema_version").get() as {
        version: number;
      }
    ).version;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  test("skips pagination_cursors repair when PK is already correct", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);
    db.query("UPDATE schema_version SET version = 5").run();

    // pagination_cursors was created by initSchema with the correct PK
    runMigrations(db);

    const row = db
      .query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='pagination_cursors'"
      )
      .get() as { sql: string };
    expect(row.sql).toContain("PRIMARY KEY (command_key, context)");
    db.close();
  });

  test("creates pagination_cursors when missing during migration 4→5", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    // Set up schema at version 4 without pagination_cursors
    const statementsWithoutPagination = Object.entries(EXPECTED_TABLES)
      .filter(([name]) => name !== "pagination_cursors")
      .map(([, ddl]) => ddl);
    db.exec(statementsWithoutPagination.join(";\n"));
    db.query("INSERT INTO schema_version (version) VALUES (4)").run();

    runMigrations(db);

    expect(tableExists(db, "pagination_cursors")).toBe(true);
    db.close();
  });

  test("migration 12→13 moves defaults data to metadata and drops table", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);

    // Recreate the old defaults table that was removed from TABLE_SCHEMAS
    db.exec(`CREATE TABLE IF NOT EXISTS defaults (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      organization TEXT,
      project TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )`);
    db.query(
      "INSERT INTO defaults (id, organization, project) VALUES (1, ?, ?)"
    ).run("migrated-org", "migrated-project");

    // Set version to 12 so migration 12→13 fires
    db.query("UPDATE schema_version SET version = 12").run();

    runMigrations(db);

    // defaults table should be dropped
    expect(tableExists(db, "defaults")).toBe(false);

    // Data should be in metadata
    const m = getMetadata(db, ["defaults.org", "defaults.project"]);
    expect(m.get("defaults.org")).toBe("migrated-org");
    expect(m.get("defaults.project")).toBe("migrated-project");

    db.close();
  });

  test("migration 12→13 handles empty defaults table", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);

    // Create old defaults table with no data
    db.exec(`CREATE TABLE IF NOT EXISTS defaults (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      organization TEXT,
      project TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )`);
    db.query("UPDATE schema_version SET version = 12").run();

    runMigrations(db);

    // Table should still be dropped even without data
    expect(tableExists(db, "defaults")).toBe(false);

    // No metadata entries created for empty values
    const m = getMetadata(db, ["defaults.org", "defaults.project"]);
    expect(m.get("defaults.org")).toBeUndefined();

    db.close();
  });

  test("migration 12→13 handles partial defaults (org only)", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);

    db.exec(`CREATE TABLE IF NOT EXISTS defaults (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      organization TEXT,
      project TEXT,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )`);
    db.query(
      "INSERT INTO defaults (id, organization, project) VALUES (1, ?, NULL)"
    ).run("only-org");
    db.query("UPDATE schema_version SET version = 12").run();

    runMigrations(db);

    expect(tableExists(db, "defaults")).toBe(false);

    const m = getMetadata(db, ["defaults.org", "defaults.project"]);
    expect(m.get("defaults.org")).toBe("only-org");
    expect(m.get("defaults.project")).toBeUndefined();

    db.close();
  });

  test("migration 12→13 skipped when defaults table does not exist", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);
    db.query("UPDATE schema_version SET version = 12").run();

    // No defaults table exists (fresh install on schema ≥13)
    runMigrations(db);

    // Should complete without error, version updated
    const version = (
      db.query("SELECT version FROM schema_version").get() as {
        version: number;
      }
    ).version;
    expect(version).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });
});

describe("repairSchema: wrong primary key", () => {
  test("detects and repairs pagination_cursors with wrong single-column PK", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);
    // Simulate the bug: drop and recreate with wrong PK
    db.exec("DROP TABLE pagination_cursors");
    db.exec(
      "CREATE TABLE pagination_cursors (command_key TEXT PRIMARY KEY, context TEXT NOT NULL, cursor TEXT NOT NULL, expires_at INTEGER NOT NULL)"
    );

    const result = repairSchema(db);

    expect(result.fixed.some((f) => f.includes("pagination_cursors"))).toBe(
      true
    );
    expect(result.failed).toEqual([]);

    const row = db
      .query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='pagination_cursors'"
      )
      .get() as { sql: string };
    expect(row.sql).toContain("PRIMARY KEY (command_key, context)");
    db.close();
  });

  test("no-op when pagination_cursors already has correct composite PK", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);

    const result = repairSchema(db);

    // Should not report pagination_cursors as fixed
    expect(result.fixed.some((f) => f.includes("pagination_cursors"))).toBe(
      false
    );
    db.close();
  });
});

describe("getSchemaIssues: wrong primary key", () => {
  test("detects wrong_primary_key when pagination_cursors has single-column PK", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);
    db.exec("DROP TABLE pagination_cursors");
    db.exec(
      "CREATE TABLE pagination_cursors (command_key TEXT PRIMARY KEY, context TEXT NOT NULL, cursor TEXT NOT NULL, expires_at INTEGER NOT NULL)"
    );

    const issues = getSchemaIssues(db);
    const pkIssues = issues.filter((i) => i.type === "wrong_primary_key");

    expect(pkIssues).toContainEqual({
      type: "wrong_primary_key",
      table: "pagination_cursors",
    });
    db.close();
  });

  test("no wrong_primary_key issues for healthy database", () => {
    const db = new Database(join(getTestDir(), "test.db"));
    initSchema(db);

    const issues = getSchemaIssues(db);
    const pkIssues = issues.filter((i) => i.type === "wrong_primary_key");

    expect(pkIssues).toEqual([]);
    db.close();
  });
});
