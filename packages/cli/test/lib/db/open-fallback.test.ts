/**
 * Tests for the in-memory fallback in `getDatabase()`.
 *
 * The database only holds caches and settings, so a `cli.db` that can't be
 * opened must not fail the command. `getDatabase()` warns and uses an
 * in-memory database instead; `getRawDatabase()` keeps throwing so repair and
 * backup code never act on the in-memory copy.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  closeDatabase,
  getDatabase,
  getRawDatabase,
} from "../../../src/lib/db/index.js";
import {
  resetReadonlyWarning,
  silenceReadonlyHandling,
} from "../../../src/lib/db/resilient.js";
import { __setDriverForTests } from "../../../src/lib/db/sqlite.js";
import { getMetadata, setMetadata } from "../../../src/lib/db/utils.js";
import { NO_PERSISTENCE_ENV_VAR, withEnv } from "../../../src/lib/env.js";
import { useTestConfigDir } from "../../helpers.js";

const getConfigDir = useTestConfigDir("db-open-fallback-");

const NOT_A_DATABASE = "this is not a SQLite database file".repeat(10);

afterEach(() => {
  __setDriverForTests(null);
  resetReadonlyWarning();
  vi.restoreAllMocks();
});

/** Capture everything written to stderr, where the logger prints warnings. */
function captureStderr(): () => string {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return () => spy.mock.calls.map((call) => String(call[0] ?? "")).join("");
}

/** Write a metadata key and read it back through `getDatabase()`. */
function writeAndReadMetadata(): string | undefined {
  const db = getDatabase();
  setMetadata(db, { "fallback-test": "ok" });
  return getMetadata(db, ["fallback-test"]).get("fallback-test");
}

describe("getDatabase when cli.db can't be opened", () => {
  test("warns and uses an in-memory database", () => {
    const dbPath = join(getConfigDir(), "cli.db");
    writeFileSync(dbPath, NOT_A_DATABASE);
    const stderr = captureStderr();

    expect(writeAndReadMetadata()).toBe("ok");

    expect(stderr()).toContain("Could not open the local database");
    expect(readFileSync(dbPath, "utf8")).toBe(NOT_A_DATABASE);
  });

  test("stays off stderr when database warnings are silenced", () => {
    writeFileSync(join(getConfigDir(), "cli.db"), NOT_A_DATABASE);
    silenceReadonlyHandling();
    const stderr = captureStderr();

    expect(writeAndReadMetadata()).toBe("ok");

    expect(stderr()).not.toContain("Could not open the local database");
  });

  test("getRawDatabase throws instead of returning the in-memory database", () => {
    writeFileSync(join(getConfigDir(), "cli.db"), NOT_A_DATABASE);
    captureStderr();

    getDatabase();

    expect(() => getRawDatabase()).toThrow();
  });

  test("tries cli.db again after the database is closed", () => {
    const dbPath = join(getConfigDir(), "cli.db");
    writeFileSync(dbPath, NOT_A_DATABASE);
    captureStderr();
    getDatabase();
    closeDatabase();

    rmSync(dbPath);
    expect(writeAndReadMetadata()).toBe("ok");
    expect(getRawDatabase()).toBeDefined();
  });

  test("a read-only call that can't open cli.db leaves later calls on the file", () => {
    const dbPath = join(getConfigDir(), "cli.db");
    writeFileSync(dbPath, NOT_A_DATABASE);
    const stderr = captureStderr();

    withEnv({ ...process.env, [NO_PERSISTENCE_ENV_VAR]: "1" }, () =>
      getDatabase(),
    );
    expect(stderr()).not.toContain("Could not open the local database");

    rmSync(dbPath);
    expect(writeAndReadMetadata()).toBe("ok");
    expect(getRawDatabase()).toBeDefined();
  });

  test("a WAL-mode cli.db read by the WASM driver still works", () => {
    __setDriverForTests("node");
    getDatabase();
    closeDatabase();
    // A native process that still has the database open keeps a -shm file,
    // so the WASM driver can't switch the file out of WAL mode.
    writeFileSync(join(getConfigDir(), "cli.db-shm"), "");
    captureStderr();

    __setDriverForTests("wasm");
    expect(writeAndReadMetadata()).toBe("ok");
  });
});
