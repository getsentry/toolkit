/**
 * Per-version database backups for `sentry cli upgrade undo` (#1623).
 */

import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  backupDatabase,
  getBackupDir,
  getUndoBackup,
  MAX_DATABASE_BACKUPS,
  restoreDatabaseBackup,
} from "../../../src/lib/db/backup.js";
import {
  closeDatabase,
  getDatabase,
  getDbPath,
  getRawDatabase,
} from "../../../src/lib/db/index.js";
import { __setDriverForTests, Database } from "../../../src/lib/db/sqlite.js";
import { getMetadata, setMetadata } from "../../../src/lib/db/utils.js";
import { UpgradeError } from "../../../src/lib/errors.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("db-backup-");

const MARKER = "test.marker";

function setMarker(value: string): void {
  setMetadata(getRawDatabase(), { [MARKER]: value });
}

function addAccount(id: string, token: string, active: boolean): void {
  getRawDatabase()
    .query(
      "INSERT INTO accounts (account_id, host, user_id, token, is_active) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, "https://sentry.io", `user-${id}`, token, active ? 1 : 0);
}

/** Read `cli.db` directly, without migrating it to this CLI's schema. */
function readFile<T>(read: (db: Database) => T): T {
  const db = new Database(getDbPath());
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function permissions(path: string): number {
  // oxlint-disable-next-line no-bitwise -- verifying permission bits
  return statSync(path).mode & 0o777;
}

function manifest(): {
  backups: { version: string }[];
  lastUpgrade?: { fromVersion: string; toVersion: string };
} {
  return JSON.parse(
    readFileSync(join(getBackupDir(), "manifest.json"), "utf-8"),
  );
}

describe("backupDatabase", () => {
  test("saves the database and records the upgrade", () => {
    setMarker("before");
    const backup = backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    setMarker("after");

    const copy = new Database(join(getBackupDir(), backup.file));
    try {
      expect(getMetadata(copy, [MARKER]).get(MARKER)).toBe("before");
    } finally {
      copy.close();
    }
    expect(manifest().lastUpgrade).toEqual({
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
    });
    expect(getUndoBackup("2.0.0")).toEqual(backup);
  });

  test.skipIf(process.platform === "win32")(
    "keeps backups readable only by the user",
    () => {
      const backup = backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
      expect(permissions(getBackupDir())).toBe(0o700);
      expect(permissions(join(getBackupDir(), backup.file))).toBe(0o600);
      expect(permissions(join(getBackupDir(), "manifest.json"))).toBe(0o600);
    },
  );

  test("keeps one backup per version", () => {
    setMarker("first");
    backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    setMarker("second");
    const backup = backupDatabase(getRawDatabase(), "1.0.0", "3.0.0");

    expect(manifest().backups.map((b) => b.version)).toEqual(["1.0.0"]);
    const copy = new Database(join(getBackupDir(), backup.file));
    try {
      expect(getMetadata(copy, [MARKER]).get(MARKER)).toBe("second");
    } finally {
      copy.close();
    }
  });

  test("prunes the oldest backups", () => {
    const files: string[] = [];
    for (let i = 0; i <= MAX_DATABASE_BACKUPS; i++) {
      files.push(
        backupDatabase(getRawDatabase(), `1.0.${i}`, `1.0.${i + 1}`).file,
      );
    }

    const kept = manifest().backups.map((b) => b.version);
    expect(kept).toHaveLength(MAX_DATABASE_BACKUPS);
    expect(kept).not.toContain("1.0.0");
    expect(existsSync(join(getBackupDir(), files[0] as string))).toBe(false);
    expect(
      existsSync(join(getBackupDir(), files[MAX_DATABASE_BACKUPS] as string)),
    ).toBe(true);
  });
});

describe("getUndoBackup", () => {
  function undoError(version: string): string {
    try {
      getUndoBackup(version);
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeError);
      return (error as Error).message;
    }
    throw new Error("expected getUndoBackup to throw");
  }

  test("fails when no upgrade was recorded", () => {
    expect(undoError("2.0.0")).toContain("Nothing to undo");
  });

  test("fails when this version was installed another way", () => {
    backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    expect(undoError("3.0.0")).toContain("went from 1.0.0 to 2.0.0");
  });

  test("fails when the backup file is gone", () => {
    const backup = backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    rmSync(join(getBackupDir(), backup.file));
    expect(undoError("2.0.0")).toContain("backup for 1.0.0 is missing");
  });

  test("treats an unreadable manifest as nothing to undo", () => {
    backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    writeFileSync(join(getBackupDir(), "manifest.json"), "not json");
    expect(undoError("2.0.0")).toContain("Nothing to undo");
  });
});

describe("restoreDatabaseBackup", () => {
  test("puts the backup back and keeps the current logins", () => {
    addAccount("a", "old-token", true);
    setMarker("saved");
    const backup = backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");

    getRawDatabase()
      .query("UPDATE accounts SET token = ? WHERE account_id = 'a'")
      .run("refreshed-token");
    addAccount("b", "new-login", false);
    setMarker("changed");

    const warnings = restoreDatabaseBackup(getRawDatabase(), backup);

    expect(warnings.join("\n")).toContain("Restored the database 1.0.0");
    const restored = readFile((db) => ({
      marker: getMetadata(db, [MARKER]).get(MARKER),
      accounts: db
        .query(
          "SELECT account_id, token, is_active FROM accounts ORDER BY account_id",
        )
        .all(),
    }));
    expect(restored.marker).toBe("saved");
    expect(restored.accounts).toEqual([
      { account_id: "a", token: "refreshed-token", is_active: 1 },
      { account_id: "b", token: "new-login", is_active: 0 },
    ]);
  });

  test("leaves the restored file alone for the rest of the process", () => {
    setMarker("saved");
    const backup = backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    restoreDatabaseBackup(getRawDatabase(), backup);

    setMetadata(getDatabase(), { [MARKER]: "written after restore" });

    expect(readFile((db) => getMetadata(db, [MARKER]).get(MARKER))).toBe(
      "saved",
    );
    closeDatabase();
  });

  test("warns when the backup predates multi-account storage", () => {
    addAccount("a", "token", true);
    const backup = backupDatabase(getRawDatabase(), "0.47.0", "2.0.0");
    const copy = new Database(join(getBackupDir(), backup.file));
    try {
      copy.exec("DROP TABLE accounts");
    } finally {
      copy.close();
    }

    const warnings = restoreDatabaseBackup(getRawDatabase(), backup);

    expect(warnings.join("\n")).toContain(
      "0.47.0 stores logins in an older format",
    );
  });
});

describe.each(["node", "wasm"] as const)("round trip [%s driver]", (kind) => {
  beforeEach(() => {
    __setDriverForTests(kind);
  });
  afterEach(() => {
    closeDatabase();
    __setDriverForTests(null);
  });

  test("backs up and restores the database", () => {
    expect(getRawDatabase().driverKind).toBe(kind);
    addAccount("a", "token", true);
    setMarker("saved");
    const backup = backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    setMarker("changed");

    restoreDatabaseBackup(getRawDatabase(), backup);

    expect(readFile((db) => getMetadata(db, [MARKER]).get(MARKER))).toBe(
      "saved",
    );
    expect(
      readFile((db) => db.query("SELECT token FROM accounts").all()),
    ).toEqual([{ token: "token" }]);
  });
});
