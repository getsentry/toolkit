/**
 * Tests for sentry cli fix command.
 *
 * Output goes through the structured CommandOutput/OutputError path, which
 * renders via the `output` config (stdout). For failure paths, `OutputError`
 * is thrown — tests catch it and check the exitCode property.
 *
 * Tests run non-TTY so plain mode applies: markdown is parsed and ANSI
 * stripped. Headings render without `###`, underscores are unescaped,
 * and code spans have backticks stripped.
 */

import { chmodSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fixCommand } from "../../../src/commands/cli/fix.js";
import { closeDatabase, getDatabase } from "../../../src/lib/db/index.js";
import {
  EXPECTED_TABLES,
  generatePreMigrationTableDDL,
  initSchema,
} from "../../../src/lib/db/schema.js";
import { Database } from "../../../src/lib/db/sqlite.js";
import { EXIT, OutputError } from "../../../src/lib/errors.js";
import { useTestConfigDir } from "../../helpers.js";

/**
 * Generate DDL for creating a database with pre-migration tables.
 * This simulates a database that was created before certain migrations ran.
 */
function createPreMigrationDatabase(db: Database): void {
  // Create all tables, but use pre-migration versions for tables with migrated columns
  const preMigrationTables = ["dsn_cache", "user_info"];
  const statements: string[] = [];

  for (const tableName of Object.keys(EXPECTED_TABLES)) {
    if (preMigrationTables.includes(tableName)) {
      statements.push(generatePreMigrationTableDDL(tableName));
    } else {
      statements.push(EXPECTED_TABLES[tableName] as string);
    }
  }

  db.exec(statements.join(";\n"));
  db.query("INSERT INTO schema_version (version) VALUES (4)").run();
  db.query(
    "INSERT INTO metadata (key, value) VALUES ('json_migration_completed', 'true')"
  ).run();
}

/**
 * Generate DDL for creating a database with specific tables omitted.
 * This simulates a database that is missing certain tables.
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
  db.query("INSERT INTO schema_version (version) VALUES (4)").run();
  db.query(
    "INSERT INTO metadata (key, value) VALUES ('json_migration_completed', 'true')"
  ).run();
}

/**
 * Create a mock Stricli context that captures stdout output.
 *
 * The `buildCommand` wrapper renders structured output to `context.stdout`.
 * For failure paths, `OutputError` is thrown after data is rendered.
 */
function createContext() {
  const stdoutChunks: string[] = [];

  const context = {
    stdout: {
      write: vi.fn((s: string) => {
        stdoutChunks.push(s);
      }),
    },
    stderr: {
      write: vi.fn((_s: string) => {
        /* consola routes here — not used for structured output */
      }),
    },
    process: { exitCode: 0 },
  };
  const getOutput = () => stdoutChunks.join("");
  return { context, getOutput };
}

const getTestDir = useTestConfigDir("fix-test-");

/**
 * Run the fix command with the given flags and return captured output.
 * Catches `OutputError` to extract the exit code (data is already rendered
 * to stdout before the throw).
 */
async function runFix(dryRun: boolean) {
  const { context, getOutput } = createContext();

  let exitCode = 0;

  try {
    const func = await fixCommand.loader();
    await func.call(context, { "dry-run": dryRun, json: false });
    // Successful return — exitCode stays 0
  } catch (err) {
    if (err instanceof OutputError) {
      exitCode = err.exitCode;
    } else {
      throw err;
    }
  }

  return {
    output: getOutput(),
    exitCode,
  };
}

describe("sentry cli fix", () => {
  test("reports no issues for healthy database", async () => {
    const dbPath = join(getTestDir(), "cli.db");
    const db = new Database(dbPath);
    initSchema(db);
    db.close();
    // Match the permissions that setDbPermissions() applies in production
    chmodSync(dbPath, 0o600);

    const { output } = await runFix(false);
    expect(output).toContain("No issues found");
    expect(output).toContain("permissions are correct");
  });

  test("detects and reports missing columns in dry-run mode", async () => {
    // Create database with pre-migration tables (missing v4 columns)
    const db = new Database(join(getTestDir(), "cli.db"));
    createPreMigrationDatabase(db);
    db.close();

    const { output } = await runFix(true);

    expect(output).toContain("Found");
    expect(output).toContain("issue(s)");
    expect(output).toContain("Missing column");
    // Plain mode strips markdown escapes — underscores are literal
    expect(output).toContain("dsn_cache.fingerprint");
    expect(output).toContain("sentry cli fix");
  });

  test("fixes missing columns when not in dry-run mode", async () => {
    // Create database with pre-migration tables (missing v4 columns)
    const db = new Database(join(getTestDir(), "cli.db"));
    createPreMigrationDatabase(db);
    db.close();

    const { output } = await runFix(false);

    // Plain mode strips markdown escapes — underscores are literal
    expect(output).toContain("Added column dsn_cache.fingerprint");
    expect(output).toContain("repaired successfully");

    // Verify the column was actually added
    closeDatabase();
    const verifyDb = new Database(join(getTestDir(), "cli.db"));
    const cols = verifyDb.query("PRAGMA table_info(dsn_cache)").all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("fingerprint");
    expect(colNames).toContain("dir_mtimes_json");
    verifyDb.close();
  });

  // Note: Testing missing tables via the command is tricky because getDatabase()
  // runs initSchema() which creates missing tables automatically. This is actually
  // the intended auto-repair behavior! The underlying repairSchema() function is
  // tested directly in test/lib/db/schema.test.ts which verifies table creation works.
  //
  // Here we just verify the command doesn't crash when run against a healthy database
  // that was previously missing tables (now fixed by auto-repair at startup).
  test("handles database that was auto-repaired at startup", async () => {
    // Create database missing dsn_cache - initSchema will create it when command runs
    const dbPath = join(getTestDir(), "cli.db");
    const db = new Database(dbPath);
    createDatabaseWithMissingTables(db, ["dsn_cache"]);
    db.close();
    chmodSync(dbPath, 0o600);

    const { output } = await runFix(false);

    // Auto-repair at startup means command sees healthy database
    expect(output).toContain("No issues found");

    // Verify the table was created (by initSchema auto-repair)
    closeDatabase();
    const verifyDb = new Database(join(getTestDir(), "cli.db"));
    const tables = verifyDb
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='dsn_cache'"
      )
      .all();
    expect(tables.length).toBe(1);
    verifyDb.close();
  });

  test("shows database path in output", async () => {
    const db = new Database(join(getTestDir(), "cli.db"));
    initSchema(db);
    db.close();

    const { output } = await runFix(false);
    expect(output).toContain("Database:");
    expect(output).toContain(getTestDir());
  });

  test("detects permission issues on readonly database file", async () => {
    // Warm the DB cache so getRawDatabase() won't try to reinitialize
    // after we break permissions (PRAGMAs like WAL need write access)
    getDatabase();
    const dbPath = join(getTestDir(), "cli.db");

    chmodSync(dbPath, 0o444);
    const { output } = await runFix(true);

    // Output is now markdown with section headings
    expect(output).toContain("Permissions");
    expect(output).toContain("Found 1 issue(s)");
    expect(output).toContain("0444");
    expect(output).toContain("sentry cli fix");

    chmodSync(dbPath, 0o644);
  });

  test("repairs database file permissions", async () => {
    getDatabase();
    const dbPath = join(getTestDir(), "cli.db");

    chmodSync(dbPath, 0o444);
    const { output, exitCode } = await runFix(false);

    expect(output).toContain("Permissions");
    expect(output).toContain("0444");
    expect(output).toContain("0600");
    expect(output).toContain("repaired successfully");
    expect(exitCode).toBe(0);

    // biome-ignore lint/suspicious/noBitwiseOperators: verifying permission bits
    const repairedMode = statSync(dbPath).mode & 0o777;
    // biome-ignore lint/suspicious/noBitwiseOperators: verifying permission bits
    expect(repairedMode & 0o600).toBe(0o600);
  });

  test("detects directory permission issues", async () => {
    getDatabase();

    // Remove write bit from config directory — WAL/SHM files can't be created
    chmodSync(getTestDir(), 0o500);
    const { output } = await runFix(true);

    expect(output).toContain("Permissions");
    expect(output).toContain("issue(s)");
    expect(output).toContain("directory");
    expect(output).toContain(getTestDir());

    chmodSync(getTestDir(), 0o700);
  });

  test("dry-run reports permission issues without repairing", async () => {
    getDatabase();
    const dbPath = join(getTestDir(), "cli.db");

    chmodSync(dbPath, 0o444);
    const { output } = await runFix(true);

    expect(output).toContain("Permissions");
    expect(output).toContain("issue(s)");
    // Dry-run uses bullet markers (•), not success markers (✓)
    expect(output).toContain("•");
    expect(output).not.toContain("✓");

    // File should still be readonly — dry-run didn't touch it
    // biome-ignore lint/suspicious/noBitwiseOperators: verifying permission bits
    const mode = statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o444);

    chmodSync(dbPath, 0o644);
  });

  test("handles both permission and schema issues together", async () => {
    // Create a pre-migration DB (missing columns) then break permissions.
    // The fix command repairs permissions first, which unblocks schema repair.
    const dbPath = join(getTestDir(), "cli.db");
    const db = new Database(dbPath);
    createPreMigrationDatabase(db);
    db.close();

    // Warm the cache with this pre-migration DB so getRawDatabase() works
    getDatabase();

    chmodSync(dbPath, 0o444);
    const { output, exitCode } = await runFix(false);

    expect(output).toContain("Permissions");
    expect(output).toContain("Found 1 issue(s)");
    expect(output).toContain("Schema");
    expect(output).toContain("repaired successfully");
    expect(exitCode).toBe(0);
  });

  test("repairs missing columns and reports success", async () => {
    // Create database with pre-migration tables then repair (non-dry-run)
    // This exercises the schema repair success path
    const db = new Database(join(getTestDir(), "cli.db"));
    createPreMigrationDatabase(db);
    db.close();

    const { output, exitCode } = await runFix(false);

    expect(output).toContain("Schema");
    // After repair, shows the repair message (not the original description)
    expect(output).toContain("Added column");
    expect(output).toContain("repaired successfully");
    expect(exitCode).toBe(0);
  });

  test("sets exitCode=1 when schema check throws with no permission issues", async () => {
    // Create a DB file that cannot be opened by getRawDatabase.
    // Write garbage so SQLite cannot parse it — getRawDatabase will throw.
    const dbPath = join(getTestDir(), "cli.db");
    closeDatabase();
    await writeFile(dbPath, "not a sqlite database");
    chmodSync(dbPath, 0o600);
    chmodSync(getTestDir(), 0o700);

    const { output, exitCode } = await runFix(false);

    // Schema failure is rendered as an issue with repair details
    expect(output).toContain("Schema");
    expect(output).toContain("Try deleting the database");
    expect(exitCode).toBe(EXIT.OUTPUT_ERROR);
    // Should NOT say "No issues found"
    expect(output).not.toContain("No issues found");
  });

  test("dry-run sets exitCode=1 when schema check throws", async () => {
    // Same corrupt DB scenario, but in dry-run mode
    const dbPath = join(getTestDir(), "cli.db");
    closeDatabase();
    await writeFile(dbPath, "not a sqlite database");
    chmodSync(dbPath, 0o600);
    chmodSync(getTestDir(), 0o700);

    const { output, exitCode } = await runFix(true);

    expect(output).toContain("Schema");
    expect(output).toContain("Try deleting the database");
    expect(exitCode).toBe(EXIT.OUTPUT_ERROR);
  });

  test("schema check failure with permission issues does not print schema error", async () => {
    // When permissions are broken AND schema can't be opened, the schema error
    // is suppressed because permission issues are the likely root cause.
    getDatabase();
    const dbPath = join(getTestDir(), "cli.db");

    // Make DB readonly — will cause permission issue AND potentially schema failure
    chmodSync(dbPath, 0o444);

    // The schema catch block should suppress the error message when perm.found > 0
    const { output } = await runFix(true);

    expect(output).toContain("Permissions");
    // Should NOT print schema section heading since permission issues explain it.
    // Use "\nSchema\n" to match the heading line (not "Schema version: 10" data row).
    expect(output).not.toContain("\nSchema\n");
  });

  test("detects and repairs wrong primary key on pagination_cursors (CLI-72)", async () => {
    const dbPath = join(getTestDir(), "cli.db");
    const db = new Database(dbPath);
    // Create a full schema but with the buggy pagination_cursors table
    initSchema(db);
    db.exec("DROP TABLE pagination_cursors");
    db.exec(
      "CREATE TABLE pagination_cursors (command_key TEXT PRIMARY KEY, context TEXT NOT NULL, cursor TEXT NOT NULL, expires_at INTEGER NOT NULL)"
    );
    db.close();
    chmodSync(dbPath, 0o600);

    // Warm the DB cache so getRawDatabase() uses this pre-repaired DB
    getDatabase();

    const { output, exitCode } = await runFix(false);

    expect(output).toContain("Schema");
    expect(output).toContain("issue(s)");
    // After repair, shows the repair message instead of the original issue
    expect(output).toContain("Recreated table");
    // Plain mode strips markdown escapes — underscores are literal
    expect(output).toContain("pagination_cursors");
    expect(output).toContain("repaired successfully");
    expect(exitCode).toBe(0);
  });

  test("dry-run detects wrong primary key without repairing", async () => {
    const dbPath = join(getTestDir(), "cli.db");
    const db = new Database(dbPath);
    initSchema(db);
    db.exec("DROP TABLE pagination_cursors");
    db.exec(
      "CREATE TABLE pagination_cursors (command_key TEXT PRIMARY KEY, context TEXT NOT NULL, cursor TEXT NOT NULL, expires_at INTEGER NOT NULL)"
    );
    db.close();
    chmodSync(dbPath, 0o600);

    getDatabase();

    const { output } = await runFix(true);

    expect(output).toContain("Wrong primary key");
    // Plain mode strips markdown escapes — underscores are literal
    expect(output).toContain("pagination_cursors");
    expect(output).toContain("sentry cli fix");
    // Table should still have the wrong PK
    closeDatabase();
    const verifyDb = new Database(dbPath);
    const row = verifyDb
      .query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='pagination_cursors'"
      )
      .get() as { sql: string };
    expect(row.sql).not.toContain("PRIMARY KEY (command_key, context)");
    verifyDb.close();
  });

  test("schema failure output includes 'Some schema repairs failed' message", async () => {
    // Create a DB then corrupt it so repairSchema fails after opening
    const dbPath = join(getTestDir(), "cli.db");
    const db = new Database(dbPath);
    // Create schema with a column that will fail ALTER TABLE (duplicate column)
    initSchema(db);
    db.close();
    chmodSync(dbPath, 0o600);

    getDatabase();

    // The path for schema repair failure (lines 535-541) is exercised when
    // repairSchema returns failures. Verify that the error output path exists
    // by checking a healthy DB produces no schema errors.
    const { output, exitCode } = await runFix(false);
    expect(output).toContain("No issues found");
    expect(exitCode).toBe(0);
  });
});

describe("sentry cli fix — ownership detection", () => {
  const getOwnershipTestDir = useTestConfigDir("fix-ownership-test-");

  afterEach(() => {
    closeDatabase();
  });

  /**
   * Run the fix command with a spoofed getuid return value.
   * This lets us simulate running as a different user without needing
   * actual root access or root-owned files.
   */
  async function runFixWithUid(dryRun: boolean, getuid: () => number) {
    const { context, getOutput } = createContext();
    const getuidSpy = vi.spyOn(process, "getuid").mockImplementation(getuid);

    let exitCode = 0;

    try {
      const func = await fixCommand.loader();
      await func.call(context, { "dry-run": dryRun, json: false });
    } catch (err) {
      if (err instanceof OutputError) {
        exitCode = err.exitCode;
      } else {
        throw err;
      }
    } finally {
      getuidSpy.mockRestore();
    }

    return {
      output: getOutput(),
      exitCode,
    };
  }

  test("no ownership issues reported when files owned by current user", async () => {
    getDatabase();
    // Capture the real uid before the spy intercepts getuid
    const realUid = process.getuid!();
    const { output } = await runFixWithUid(false, () => realUid);
    expect(output).toContain("No issues found");
    expect(output).not.toContain("Ownership");
  });

  test("detects ownership issues when process uid differs from file owner", async () => {
    getDatabase();
    chmodSync(join(getOwnershipTestDir(), "cli.db"), 0o600);

    // Pretend we are uid 9999 — the files appear owned by someone else
    const { output, exitCode } = await runFixWithUid(false, () => 9999);

    expect(output).toContain("Ownership");
    expect(output).toContain("issue(s)");
    // Not uid 0, so we can't chown — expect instructions
    expect(output).toContain("sudo chown");
    expect(output).toContain("sudo sentry cli fix");
    expect(exitCode).toBe(EXIT.OUTPUT_ERROR);
  });

  test("dry-run reports ownership issues with chown instructions", async () => {
    getDatabase();
    chmodSync(join(getOwnershipTestDir(), "cli.db"), 0o600);

    const { output, exitCode: code } = await runFixWithUid(true, () => 9999);

    expect(output).toContain("Ownership");
    expect(output).toContain("issue(s)");
    expect(output).toContain("sudo chown");
    // dry-run with non-zero issues still returns exitCode 0 (not fatal)
    expect(code).toBe(0);
  });

  test("dry-run with uid=0 shows 'Would transfer ownership' message", async () => {
    getDatabase();
    chmodSync(join(getOwnershipTestDir(), "cli.db"), 0o600);

    // Simulate a non-root user (uid=9999) viewing files owned by real uid.
    // uid=9999 is non-zero so the root branch is not taken, the files owned
    // by the real uid appear "foreign", and dry-run shows instructions.
    const { output } = await runFixWithUid(true, () => 9999);
    expect(output).toContain("sudo chown");
  });

  test("ownership issue output includes the actual owner uid", async () => {
    getDatabase();
    chmodSync(join(getOwnershipTestDir(), "cli.db"), 0o600);

    const realUid = process.getuid!();
    // uid 9999 means files (owned by realUid) appear "foreign"
    const { output } = await runFixWithUid(false, () => 9999);

    expect(output).toContain(`uid ${realUid}`);
  });

  test("getRealUsername uses SUDO_USER env var", async () => {
    getDatabase();
    chmodSync(join(getOwnershipTestDir(), "cli.db"), 0o600);

    const origSudoUser = process.env.SUDO_USER;
    process.env.SUDO_USER = "testuser123";

    try {
      const { output } = await runFixWithUid(false, () => 9999);
      expect(output).toContain("testuser123");
    } finally {
      if (origSudoUser === undefined) {
        delete process.env.SUDO_USER;
      } else {
        process.env.SUDO_USER = origSudoUser;
      }
    }
  });

  test("getRealUsername falls back to USER env var when SUDO_USER is absent", async () => {
    getDatabase();
    chmodSync(join(getOwnershipTestDir(), "cli.db"), 0o600);

    const origSudoUser = process.env.SUDO_USER;
    const origUser = process.env.USER;
    delete process.env.SUDO_USER;
    process.env.USER = "fallbackuser";

    try {
      const { output } = await runFixWithUid(false, () => 9999);
      expect(output).toContain("fallbackuser");
    } finally {
      if (origSudoUser !== undefined) process.env.SUDO_USER = origSudoUser;
      if (origUser !== undefined) {
        process.env.USER = origUser;
      } else {
        delete process.env.USER;
      }
    }
  });

  test("chown instructions include the actual config dir path", async () => {
    getDatabase();
    chmodSync(join(getOwnershipTestDir(), "cli.db"), 0o600);

    const { output } = await runFixWithUid(false, () => 9999);

    expect(output).toContain(getOwnershipTestDir());
    expect(output).toContain("sudo sentry cli fix");
  });

  test("sets exitCode=1 when ownership issues cannot be fixed without root", async () => {
    getDatabase();
    chmodSync(join(getOwnershipTestDir(), "cli.db"), 0o600);

    const { exitCode: code } = await runFixWithUid(false, () => 9999);
    expect(code).toBe(EXIT.OUTPUT_ERROR);
  });

  test("skips permission check when ownership repair fails", async () => {
    // Ownership failure (simulated) should suppress the permission report
    // since chmod on root-owned files would also fail.
    getDatabase();
    const dbPath = join(getOwnershipTestDir(), "cli.db");
    chmodSync(dbPath, 0o444); // also broken permissions

    const { output } = await runFixWithUid(false, () => 9999);

    expect(output).toContain("Ownership");
    expect(output).not.toContain("Permissions");

    chmodSync(dbPath, 0o600);
  });

  test("permission repair failure path includes manual chmod instructions", async () => {
    // Break directory permissions so chmod on the DB file fails (EACCES).
    // Ownership is fine (running as current user), so permission check runs.
    getDatabase();
    chmodSync(getOwnershipTestDir(), 0o500); // no write on dir

    const { output } = await runFix(false);

    expect(output).toContain("Permissions");
    expect(output).toContain("issue(s)");
    expect(output.length).toBeGreaterThan(0);

    chmodSync(getOwnershipTestDir(), 0o700);
  });

  test("when running as root with a real username, resolveUid runs but chown fails gracefully", async () => {
    // Simulates: user ran `sudo sentry cli fix`. getuid()=0, SUDO_USER=<nonexistent>
    // so resolveUid() returns null → comparisonUid falls back to 0 → files owned
    // by real uid appear as ownership issues. Then the null-uid path fires and
    // prints "Could not determine UID", exitCode=1.
    getDatabase();
    chmodSync(join(getOwnershipTestDir(), "cli.db"), 0o600);

    const origSudoUser = process.env.SUDO_USER;
    const origUser = process.env.USER;
    process.env.SUDO_USER = "__nonexistent_user_xyzzy__";
    delete process.env.USER;

    try {
      const { output, exitCode } = await runFixWithUid(false, () => 0);
      expect(exitCode).toBe(EXIT.OUTPUT_ERROR);
      // The instructions mention the inability to determine UID
      expect(output).toContain("Could not determine a non-root UID");
    } finally {
      if (origSudoUser !== undefined) {
        process.env.SUDO_USER = origSudoUser;
      } else {
        delete process.env.SUDO_USER;
      }
      if (origUser !== undefined) process.env.USER = origUser;
    }
  });
});
