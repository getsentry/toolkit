/**
 * Per-version backups of `cli.db` for `sentry cli upgrade undo` (#1623).
 *
 * Before `sentry cli upgrade` hands the database to another version, it
 * copies `cli.db` to `backups/cli-<version>.db` under the config directory
 * and records which version it moved from. `sentry cli upgrade undo`
 * reinstalls that version and puts its own database back, so newer CLIs
 * don't have to know how to rewrite their schema for older ones.
 *
 * Backups hold credentials, so the directory is `0700` and files `0600`,
 * like `cli.db` itself.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stringifyUnknown, UpgradeError } from "../errors.js";
import { logger } from "../logger.js";
import {
  closeDatabase,
  detachDatabase,
  getConfigDir,
  getDbPath,
} from "./index.js";
import { tableExists } from "./schema.js";
import { Database, type SQLQueryBindings } from "./sqlite.js";

const log = logger.withTag("db.backup");

const BACKUP_SUBDIR = "backups";
const MANIFEST_FILENAME = "manifest.json";

/**
 * Backups kept at most. There is one per version, so nightly users would
 * otherwise collect one per nightly they ever ran.
 */
export const MAX_DATABASE_BACKUPS = 5;

/** A saved copy of the database as one CLI version left it. */
export type DatabaseBackup = {
  /** CLI version that last used this database. */
  version: string;
  /** File name inside the backup directory. */
  file: string;
  /** When the copy was made (ms since epoch). */
  createdAt: number;
};

/** The most recent version change made through `sentry cli upgrade`. */
type UpgradeRecord = {
  fromVersion: string;
  toVersion: string;
};

type BackupManifest = {
  backups: DatabaseBackup[];
  lastUpgrade?: UpgradeRecord;
};

/** Directory holding database backups and their manifest. */
export function getBackupDir(): string {
  return join(getConfigDir(), BACKUP_SUBDIR);
}

function manifestPath(): string {
  return join(getBackupDir(), MANIFEST_FILENAME);
}

function isBackup(value: unknown): value is DatabaseBackup {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.version === "string" &&
    typeof entry.file === "string" &&
    typeof entry.createdAt === "number"
  );
}

function isUpgradeRecord(value: unknown): value is UpgradeRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.fromVersion === "string" &&
    typeof record.toVersion === "string"
  );
}

/** Read the manifest, treating a missing or unreadable one as empty. */
function readManifest(): BackupManifest {
  const path = manifestPath();
  if (!existsSync(path)) {
    return { backups: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    const backups = Array.isArray(parsed.backups)
      ? parsed.backups.filter(isBackup)
      : [];
    const lastUpgrade = isUpgradeRecord(parsed.lastUpgrade)
      ? parsed.lastUpgrade
      : undefined;
    return { backups, lastUpgrade };
  } catch (error) {
    log.debug(`Ignoring unreadable backup manifest ${path}`, error);
    return { backups: [] };
  }
}

/** Write the manifest atomically, readable only by the user. */
function writeManifest(manifest: BackupManifest): void {
  const path = manifestPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, path);
}

function ensureBackupDir(): string {
  const dir = getBackupDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch (error) {
    // Windows has no POSIX modes; the directory inherits the profile's ACLs.
    log.debug(`Could not restrict ${dir}`, error);
  }
  return dir;
}

function restrictFile(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    log.debug(`Could not restrict ${path}`, error);
  }
}

/** File name for a version's backup; versions are plain semver strings. */
function backupFileName(version: string): string {
  return `cli-${version.replace(/[^A-Za-z0-9._-]/g, "_")}.db`;
}

/**
 * Keep the newest {@link MAX_DATABASE_BACKUPS} backups, plus the one an undo
 * would restore, and delete the files of the rest.
 */
function pruneBackups(manifest: BackupManifest, dir: string): void {
  const undoVersion = manifest.lastUpgrade?.fromVersion;
  // Entries are appended as they are made, so reversing first keeps the
  // newest first among backups made within the same millisecond.
  const newestFirst = [...manifest.backups]
    .reverse()
    .sort((a, b) => b.createdAt - a.createdAt);
  const kept: DatabaseBackup[] = [];
  for (const entry of newestFirst) {
    if (kept.length < MAX_DATABASE_BACKUPS || entry.version === undoVersion) {
      kept.push(entry);
      continue;
    }
    rmSync(join(dir, entry.file), { force: true });
  }
  manifest.backups = kept;
}

/**
 * Save `db` as `fromVersion`'s backup and record the move to `toVersion`,
 * so `sentry cli upgrade undo` run from `toVersion` can return to it.
 *
 * Replaces any earlier backup of `fromVersion`. Uses `VACUUM INTO`, which
 * takes a consistent snapshot even while other CLI processes use `db`.
 */
export function backupDatabase(
  db: Database,
  fromVersion: string,
  toVersion: string,
): DatabaseBackup {
  const dir = ensureBackupDir();
  const manifest = readManifest();
  // Drop the record first: if the copy fails, an undo must not restore a
  // backup that predates this upgrade.
  if (manifest.lastUpgrade) {
    manifest.lastUpgrade = undefined;
    writeManifest(manifest);
  }

  const file = backupFileName(fromVersion);
  const path = join(dir, file);
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  try {
    db.query("VACUUM INTO ?").run(tmp);
    restrictFile(tmp);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }

  const entry: DatabaseBackup = {
    version: fromVersion,
    file,
    createdAt: Date.now(),
  };
  manifest.backups = [
    ...manifest.backups.filter((b) => b.version !== fromVersion),
    entry,
  ];
  manifest.lastUpgrade = { fromVersion, toVersion };
  pruneBackups(manifest, dir);
  writeManifest(manifest);
  return entry;
}

/**
 * Find the backup `sentry cli upgrade undo` should restore when run from
 * `currentVersion`.
 *
 * @throws {UpgradeError} When no upgrade to `currentVersion` was recorded,
 *   or its backup is gone.
 */
export function getUndoBackup(currentVersion: string): DatabaseBackup {
  const { backups, lastUpgrade } = readManifest();
  if (!lastUpgrade) {
    throw new UpgradeError(
      "unsupported_operation",
      "Nothing to undo: no upgrade made with `sentry cli upgrade` was recorded.",
    );
  }
  if (lastUpgrade.toVersion !== currentVersion) {
    throw new UpgradeError(
      "unsupported_operation",
      `Nothing to undo: the last recorded upgrade went from ${lastUpgrade.fromVersion} to ${lastUpgrade.toVersion}, ` +
        `but this is ${currentVersion}. It was probably installed another way.`,
    );
  }
  const backup = backups.find((b) => b.version === lastUpgrade.fromVersion);
  if (!(backup && existsSync(join(getBackupDir(), backup.file)))) {
    throw new UpgradeError(
      "unsupported_operation",
      `Cannot undo: the database backup for ${lastUpgrade.fromVersion} is missing. ` +
        `Run \`sentry cli upgrade ${lastUpgrade.fromVersion}\` instead.`,
    );
  }
  return backup;
}

/** Columns of `table` in `db`, in declaration order. */
function columnNames(db: Database, table: string): string[] {
  const rows = db
    .query(`SELECT name FROM pragma_table_info('${table}')`)
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

type AccountRows = {
  columns: string[];
  rows: Record<string, SQLQueryBindings>[];
};

function readAccounts(db: Database): AccountRows | undefined {
  if (!tableExists(db, "accounts")) {
    return;
  }
  return {
    columns: columnNames(db, "accounts"),
    rows: db.query("SELECT * FROM accounts").all(),
  };
}

/**
 * Replace the accounts in `restored` with `current`'s, so the undo keeps
 * the logins and refreshed tokens made since the backup, and logins
 * removed since then stay removed.
 *
 * @returns A warning when they could not be carried over.
 */
function carryOverAccounts(
  restored: Database,
  current: AccountRows | undefined,
  backup: DatabaseBackup,
): string | undefined {
  if (!current) {
    return;
  }
  const loginHint = `Your logins are as they were in ${backup.version}; run \`sentry auth login\` if you need another.`;
  if (!tableExists(restored, "accounts")) {
    if (current.rows.length > 0) {
      return `${backup.version} stores logins in an older format, so your current logins could not be kept. ${loginHint}`;
    }
    // Logged out since the backup: don't bring the older login back.
    if (tableExists(restored, "auth")) {
      restored.query("DELETE FROM auth").run();
    }
    return;
  }
  const restoredColumns = new Set(columnNames(restored, "accounts"));
  const shared = current.columns.filter((c) => restoredColumns.has(c));
  const placeholders = shared.map(() => "?").join(", ");
  try {
    restored.transaction(() => {
      restored.query("DELETE FROM accounts").run();
      const insert = restored.query(
        `INSERT INTO accounts (${shared.join(", ")}) VALUES (${placeholders})`,
      );
      for (const row of current.rows) {
        insert.run(...shared.map((c) => row[c]));
      }
    })();
  } catch (error) {
    log.debug("Could not carry accounts into the restored database", error);
    return `Could not keep your current logins (${stringifyUnknown(error)}). ${loginHint}`;
  }
  return;
}

/**
 * Put `backup` back as `cli.db`, keeping the current logins when the
 * backup's schema allows it.
 *
 * Detaches the database from this process first: reopening the restored
 * file here would migrate it back to this version's schema.
 *
 * @param db - This process's open connection to `cli.db`
 * @returns What the user should know about the restored state
 */
export function restoreDatabaseBackup(
  db: Database,
  backup: DatabaseBackup,
): string[] {
  const source = join(getBackupDir(), backup.file);
  const dbPath = getDbPath();
  const tmp = `${dbPath}.restore-${process.pid}`;
  const currentAccounts = readAccounts(db);
  const warnings: string[] = [];

  rmSync(tmp, { force: true });
  try {
    copyFileSync(source, tmp);
    restrictFile(tmp);
    const restored = new Database(tmp);
    try {
      const warning = carryOverAccounts(restored, currentAccounts, backup);
      if (warning) {
        warnings.push(warning);
      }
    } finally {
      restored.close();
    }

    // Fold the write-ahead log into `cli.db`, then let it go for good.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    detachDatabase();
    try {
      // A leftover write-ahead log belongs to the replaced file and would
      // corrupt the restored one.
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      renameSync(tmp, dbPath);
    } catch (error) {
      // `cli.db` is still this version's; let callers use it again.
      closeDatabase();
      throw error;
    }
  } finally {
    rmSync(tmp, { force: true });
  }

  const savedOn = new Date(backup.createdAt).toISOString().slice(0, 10);
  warnings.push(
    `Restored the database ${backup.version} saved on ${savedOn}. Other changes since then, such as defaults, are undone.`,
  );
  return warnings;
}
