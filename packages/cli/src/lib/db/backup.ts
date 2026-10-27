/**
 * Per-version backups of `cli.db` for `sentry cli upgrade undo` (#1623).
 *
 * Before `sentry cli upgrade` hands the database to another version, it
 * copies `cli.db` to `backups/cli-<from>_to_<to>.db` under the config
 * directory. The file name is the whole record: the newest backup is the
 * last upgrade, and `sentry cli upgrade undo` run from `<to>` reinstalls
 * `<from>` and puts that file back, so newer CLIs don't have to know how to
 * rewrite their schema for older ones.
 *
 * Backups hold credentials, so the directory is `0700` and files `0600`,
 * like `cli.db` itself.
 */

import type { Dirent } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  opendir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
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

/** Characters semver allows; `_` is not one, so it can separate versions. */
const VERSION_PATTERN = "[0-9A-Za-z.+-]+";
const VERSION_REGEX = new RegExp(`^${VERSION_PATTERN}$`);
const BACKUP_FILE_REGEX = new RegExp(
  `^cli-(${VERSION_PATTERN})_to_(${VERSION_PATTERN})\\.db$`,
);

/**
 * Backups kept at most. There is one per version, so nightly users would
 * otherwise collect one per nightly they ever ran.
 */
export const MAX_DATABASE_BACKUPS = 5;

/** A saved copy of the database as one CLI version left it. */
export type DatabaseBackup = {
  /** CLI version that last used this database. */
  version: string;
  /** Version `sentry cli upgrade` moved to after saving it. */
  toVersion: string;
  /** File name inside the backup directory. */
  file: string;
  /** When the copy was made (ms since epoch), from the file's mtime. */
  createdAt: number;
};

/** Directory holding database backups. */
export function getBackupDir(): string {
  return join(getConfigDir(), BACKUP_SUBDIR);
}

function backupFileName(fromVersion: string, toVersion: string): string {
  for (const version of [fromVersion, toVersion]) {
    if (!VERSION_REGEX.test(version)) {
      throw new Error(`Cannot name a database backup for version ${version}`);
    }
  }
  return `cli-${fromVersion}_to_${toVersion}.db`;
}

/** Every backup in the backup directory, newest first. */
async function listBackups(): Promise<DatabaseBackup[]> {
  const dir = getBackupDir();
  let entries: AsyncIterable<Dirent>;
  try {
    entries = await opendir(dir);
  } catch (error) {
    log.debug(`Cannot read backup directory ${dir}`, error);
    return [];
  }
  const backups: DatabaseBackup[] = [];
  for await (const entry of entries) {
    const match = entry.isFile() ? BACKUP_FILE_REGEX.exec(entry.name) : null;
    if (!match) {
      continue;
    }
    try {
      const { mtimeMs } = await stat(join(dir, entry.name));
      backups.push({
        version: match[1] as string,
        toVersion: match[2] as string,
        file: entry.name,
        createdAt: mtimeMs,
      });
    } catch (error) {
      // Removed by a concurrent prune.
      log.debug(`Skipping backup ${entry.name}`, error);
    }
  }
  return backups.sort((a, b) => b.createdAt - a.createdAt);
}

async function ensureBackupDir(): Promise<string> {
  const dir = getBackupDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch (error) {
    // Windows has no POSIX modes; the directory inherits the profile's ACLs.
    log.debug(`Could not restrict ${dir}`, error);
  }
  return dir;
}

async function restrictFile(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    log.debug(`Could not restrict ${path}`, error);
  }
}

/**
 * Save `db` as `fromVersion`'s backup, named for the move to `toVersion`,
 * so `sentry cli upgrade undo` run from `toVersion` can return to it.
 *
 * Replaces any earlier backup of `fromVersion` and keeps the newest
 * {@link MAX_DATABASE_BACKUPS}. Uses `VACUUM INTO`, which takes a
 * consistent snapshot even while other CLI processes use `db`.
 */
export async function backupDatabase(
  db: Database,
  fromVersion: string,
  toVersion: string,
): Promise<DatabaseBackup> {
  const file = backupFileName(fromVersion, toVersion);
  const dir = await ensureBackupDir();
  const path = join(dir, file);
  const tmp = `${path}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  try {
    db.query("VACUUM INTO ?").run(tmp);
    await restrictFile(tmp);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }

  // Newest first, so the first ones left after this version's older copies
  // are the ones to keep alongside the new backup.
  const others = (await listBackups()).filter((b) => b.file !== file);
  const stale = [
    ...others.filter((b) => b.version === fromVersion),
    ...others
      .filter((b) => b.version !== fromVersion)
      .slice(MAX_DATABASE_BACKUPS - 1),
  ];
  await Promise.all(stale.map((b) => rm(join(dir, b.file), { force: true })));
  const { mtimeMs } = await stat(path);
  return { version: fromVersion, toVersion, file, createdAt: mtimeMs };
}

/**
 * Find the backup `sentry cli upgrade undo` should restore when run from
 * `currentVersion`: the newest one, if it was made upgrading to it.
 *
 * @throws {UpgradeError} When there is no backup, or the newest one was
 *   made upgrading to another version.
 */
export async function getUndoBackup(
  currentVersion: string,
): Promise<DatabaseBackup> {
  const [last] = await listBackups();
  if (!last) {
    throw new UpgradeError(
      "unsupported_operation",
      "Nothing to undo: no upgrade made with `sentry cli upgrade` was recorded.",
    );
  }
  if (last.toVersion !== currentVersion) {
    throw new UpgradeError(
      "unsupported_operation",
      `Nothing to undo: the last recorded upgrade went from ${last.version} to ${last.toVersion}, ` +
        `but this is ${currentVersion}. It was probably installed another way.`,
    );
  }
  return last;
}

/** Delete `backup`, made for an upgrade that didn't happen. */
export async function discardDatabaseBackup(
  backup: DatabaseBackup,
): Promise<void> {
  await rm(join(getBackupDir(), backup.file), { force: true });
}

/**
 * Move `backup` back into place as `cli.db` and let this process use it
 * again, reverting a restore or hand-off made for a version that was never
 * installed. The backup file is gone afterwards, as if the upgrade it was
 * made for never happened.
 */
export async function reinstateDatabaseBackup(
  backup: DatabaseBackup,
): Promise<void> {
  const dbPath = getDbPath();
  // Nothing in this process may use the file being replaced meanwhile.
  detachDatabase();
  try {
    // The write-ahead log belongs to the file being replaced.
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await rename(join(getBackupDir(), backup.file), dbPath);
  } finally {
    closeDatabase();
  }
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
export async function restoreDatabaseBackup(
  db: Database,
  backup: DatabaseBackup,
): Promise<string[]> {
  const source = join(getBackupDir(), backup.file);
  const dbPath = getDbPath();
  const tmp = `${dbPath}.restore-${process.pid}`;
  const warnings: string[] = [];

  await rm(tmp, { force: true });
  try {
    await copyFile(source, tmp);
    await restrictFile(tmp);
    const restored = new Database(tmp);
    try {
      const warning = carryOverAccounts(restored, readAccounts(db), backup);
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
      await rm(`${dbPath}-wal`, { force: true });
      await rm(`${dbPath}-shm`, { force: true });
      await rename(tmp, dbPath);
    } catch (error) {
      // `cli.db` is still this version's; let callers use it again.
      closeDatabase();
      throw error;
    }
  } finally {
    await rm(tmp, { force: true });
  }

  const savedOn = new Date(backup.createdAt).toISOString().slice(0, 10);
  warnings.push(
    `Restored the database ${backup.version} saved on ${savedOn}. Other changes since then, such as defaults, are undone.`,
  );
  return warnings;
}
