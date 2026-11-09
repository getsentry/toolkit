/**
 * Per-version database backups for `sentry cli upgrade undo` (#1623).
 */

import { statSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
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

/** Backup file names in the backup directory, sorted. */
async function backupFiles(): Promise<string[]> {
  return (await readdir(getBackupDir())).sort();
}

describe("backupDatabase", () => {
  test("saves the database under a name recording the upgrade", async () => {
    setMarker("before");
    const backup = await backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    setMarker("after");

    expect(backup.file).toBe("cli-1.0.0_to_2.0.0.db");
    const copy = new Database(join(getBackupDir(), backup.file));
    try {
      expect(getMetadata(copy, [MARKER]).get(MARKER)).toBe("before");
    } finally {
      copy.close();
    }
    expect(await getUndoBackup("2.0.0")).toEqual(backup);
  });

  test("keeps prerelease and build versions in the name", async () => {
    const backup = await backupDatabase(
      getRawDatabase(),
      "1.0.0-dev.1700000000",
      "1.0.0+build.5",
    );

    expect(await getUndoBackup("1.0.0+build.5")).toEqual(backup);
  });

  test("rejects a version that can't be part of a file name", async () => {
    await expect(
      backupDatabase(getRawDatabase(), "../1.0.0", "2.0.0"),
    ).rejects.toThrow("Cannot name a database backup");
  });

  test.skipIf(process.platform === "win32")(
    "keeps backups readable only by the user",
    async () => {
      const backup = await backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
      expect(permissions(getBackupDir())).toBe(0o700);
      expect(permissions(join(getBackupDir(), backup.file))).toBe(0o600);
    },
  );

  test("keeps one backup per version", async () => {
    setMarker("first");
    await backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    setMarker("second");
    const backup = await backupDatabase(getRawDatabase(), "1.0.0", "3.0.0");

    expect(await backupFiles()).toEqual(["cli-1.0.0_to_3.0.0.db"]);
    const copy = new Database(join(getBackupDir(), backup.file));
    try {
      expect(getMetadata(copy, [MARKER]).get(MARKER)).toBe("second");
    } finally {
      copy.close();
    }
  });

  test("prunes the oldest backups", async () => {
    const files: string[] = [];
    for (let i = 0; i <= MAX_DATABASE_BACKUPS; i++) {
      const { file } = await backupDatabase(
        getRawDatabase(),
        `1.0.${i}`,
        `1.0.${i + 1}`,
      );
      files.push(file);
    }

    expect(await backupFiles()).toEqual(files.slice(1).sort());
  });
});

describe("getUndoBackup", () => {
  async function undoError(version: string): Promise<string> {
    try {
      await getUndoBackup(version);
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeError);
      return (error as Error).message;
    }
    throw new Error("expected getUndoBackup to throw");
  }

  test("fails when no upgrade was recorded", async () => {
    expect(await undoError("2.0.0")).toContain("Nothing to undo");
  });

  test("fails when this version was installed another way", async () => {
    await backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    expect(await undoError("3.0.0")).toContain("went from 1.0.0 to 2.0.0");
  });

  test("only undoes the newest upgrade", async () => {
    await backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    await backupDatabase(getRawDatabase(), "2.0.0", "3.0.0");
    expect(await undoError("2.0.0")).toContain("went from 2.0.0 to 3.0.0");
  });

  test("fails when the backup file is gone", async () => {
    const backup = await backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    await rm(join(getBackupDir(), backup.file));
    expect(await undoError("2.0.0")).toContain("Nothing to undo");
  });

  test("ignores other files in the backup directory", async () => {
    const backup = await backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    await writeFile(join(getBackupDir(), "notes.txt"), "not a backup");
    await writeFile(join(getBackupDir(), "cli-9.0.0.db"), "");
    await mkdir(join(getBackupDir(), "cli-9.0.0_to_2.0.0.db"));
    expect(await getUndoBackup("2.0.0")).toEqual(backup);
  });
});

describe("restoreDatabaseBackup", () => {
  test("puts the backup back and keeps the current logins", async () => {
    addAccount("a", "old-token", true);
    setMarker("saved");
    const backup = await backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");

    getRawDatabase()
      .query("UPDATE accounts SET token = ? WHERE account_id = 'a'")
      .run("refreshed-token");
    addAccount("b", "new-login", false);
    setMarker("changed");

    const warnings = await restoreDatabaseBackup(getRawDatabase(), backup);

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

  test("keeps the user logged out when they logged out since the backup", async () => {
    addAccount("a", "token", true);
    const backup = await backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    getRawDatabase().query("DELETE FROM accounts").run();

    const warnings = await restoreDatabaseBackup(getRawDatabase(), backup);

    expect(warnings.join("\n")).not.toContain("logins");
    expect(
      readFile((db) => db.query("SELECT account_id FROM accounts").all()),
    ).toEqual([]);
  });

  test("leaves the restored file alone for the rest of the process", async () => {
    setMarker("saved");
    const backup = await backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    await restoreDatabaseBackup(getRawDatabase(), backup);

    setMetadata(getDatabase(), { [MARKER]: "written after restore" });

    expect(readFile((db) => getMetadata(db, [MARKER]).get(MARKER))).toBe(
      "saved",
    );
    closeDatabase();
  });

  test("warns when the backup predates multi-account storage", async () => {
    addAccount("a", "token", true);
    const backup = await backupDatabase(getRawDatabase(), "0.47.0", "2.0.0");
    const copy = new Database(join(getBackupDir(), backup.file));
    try {
      copy.exec("DROP TABLE accounts");
    } finally {
      copy.close();
    }

    const warnings = await restoreDatabaseBackup(getRawDatabase(), backup);

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

  test("backs up and restores the database", async () => {
    expect(getRawDatabase().driverKind).toBe(kind);
    addAccount("a", "token", true);
    setMarker("saved");
    const backup = await backupDatabase(getRawDatabase(), "1.0.0", "2.0.0");
    setMarker("changed");

    await restoreDatabaseBackup(getRawDatabase(), backup);

    expect(readFile((db) => getMetadata(db, [MARKER]).get(MARKER))).toBe(
      "saved",
    );
    expect(
      readFile((db) => db.query("SELECT token FROM accounts").all()),
    ).toEqual([{ token: "token" }]);
  });
});
