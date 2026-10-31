/**
 * Tests for the schema auto-repair and read-only handling wrapper around
 * the CLI database.
 */

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getDatabase, getRawDatabase } from "../../../src/lib/db/index.js";
import {
  createResilientDatabase,
  resetReadonlyWarning,
} from "../../../src/lib/db/resilient.js";
import {
  generatePreMigrationTableDDL,
  hasColumn,
} from "../../../src/lib/db/schema.js";
import { Database } from "../../../src/lib/db/sqlite.js";
import { useTestConfigDir } from "../../helpers.js";

describe("getDatabase with telemetry off", () => {
  useTestConfigDir("resilient-test-");

  // Regression: with telemetry off (including every `sentry __complete` run),
  // getDatabase() used to return the raw connection, so schema errors threw
  // instead of being repaired.
  beforeEach(() => {
    expect(process.env.SENTRY_CLI_NO_TELEMETRY).toBe("1");
  });

  test("repairs a missing table and retries the query", () => {
    getDatabase();
    getRawDatabase().exec("DROP TABLE completion_cache");

    const rows = getDatabase().query("SELECT * FROM completion_cache").all();

    expect(rows).toEqual([]);
  });

  test("repairs a missing column and retries the query", () => {
    getDatabase();
    const raw = getRawDatabase();
    raw.exec("DROP TABLE dsn_cache");
    raw.exec(generatePreMigrationTableDDL("dsn_cache"));
    expect(hasColumn(raw, "dsn_cache", "fingerprint")).toBe(false);

    const rows = getDatabase().query("SELECT fingerprint FROM dsn_cache").all();

    expect(rows).toEqual([]);
    expect(hasColumn(raw, "dsn_cache", "fingerprint")).toBe(true);
  });
});

describe("createResilientDatabase: readonly database", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    resetReadonlyWarning();

    tmpDir = `${import.meta.dirname}/tmp-readonly-${Date.now()}`;
    mkdirSync(tmpDir, { recursive: true });
    dbPath = `${tmpDir}/test.db`;

    const setupDb = new Database(dbPath);
    setupDb.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)");
    setupDb.exec("INSERT INTO test (id, name) VALUES (1, 'Alice')");
    setupDb.close();

    chmodSync(dbPath, 0o444);
  });

  afterEach(() => {
    try {
      chmodSync(dbPath, 0o644);
    } catch {
      // May already be cleaned up
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("does not throw on write to readonly database", () => {
    // bun:sqlite opens the file successfully — the error only surfaces on write
    const db = new Database(dbPath);
    const wrappedDb = createResilientDatabase(db);

    expect(() => {
      wrappedDb
        .query("INSERT INTO test (id, name) VALUES (?, ?)")
        .run(2, "Bob");
    }).not.toThrow();

    db.close();
  });

  test("reads still work on readonly database", () => {
    const db = new Database(dbPath);
    const wrappedDb = createResilientDatabase(db);

    const row = wrappedDb.query("SELECT * FROM test WHERE id = ?").get(1) as {
      id: number;
      name: string;
    };
    expect(row).toEqual({ id: 1, name: "Alice" });

    db.close();
  });

  test("all() and values() return empty arrays on readonly write", () => {
    const db = new Database(dbPath);
    const wrappedDb = createResilientDatabase(db);

    const allResult = wrappedDb
      .query("INSERT INTO test (id, name) VALUES (?, ?)")
      .all(2, "Bob");
    expect(allResult).toEqual([]);

    // values() is bun:sqlite-specific; skip on Node.js
    const stmt = wrappedDb.query("INSERT INTO test (id, name) VALUES (?, ?)");
    if (typeof stmt.values === "function") {
      const valuesResult = stmt.values(3, "Charlie");
      expect(valuesResult).toEqual([]);
    }

    db.close();
  });

  test("shows readonly warning when auto-repair fails", () => {
    // Mock chmodSync to always throw, simulating a file owned by another user.
    // This makes tryRepairReadonly fail and fall through to warnReadonlyDatabaseOnce.
    const fs = require("node:fs");
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), {
        code: "EPERM",
      });
    });

    const db = new Database(dbPath);
    const wrappedDb = createResilientDatabase(db);

    const stderrSpy = vi.spyOn(process.stderr, "write");

    wrappedDb.query("INSERT INTO test (id, name) VALUES (?, ?)").run(2, "Bob");

    const output = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    // When repair fails, the warning message should appear instead
    expect(output).toContain("read-only");
    expect(output).toContain("sentry cli fix");

    stderrSpy.mockRestore();
    chmodSpy.mockRestore();
    db.close();
  });
});
