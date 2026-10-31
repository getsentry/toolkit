/**
 * Self-healing wrapper for the CLI's SQLite connection.
 *
 * Wraps `query()` and the statement execution methods so that:
 * - schema errors (missing table/column) trigger {@link tryRepairAndRetry}
 * - writes to a read-only database are skipped with a one-time warning
 *
 * This module must stay free of `@sentry/node` so it also applies when
 * telemetry is off (including the shell-completion fast path). Telemetry adds
 * query spans by passing a {@link QueryRunner} (see `createTracedDatabase` in
 * `telemetry.ts`).
 */

import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { getRealUsername } from "../utils.js";
import { isReadonlyError, tryRepairAndRetry } from "./schema.js";
import type { Database } from "./sqlite.js";

const _require = createRequire(import.meta.url);

/**
 * Runs one statement execution. Telemetry passes a runner that wraps the call
 * in a span; the default just calls it.
 */
export type QueryRunner = <T>(sql: string, execute: () => T) => T;

const runDirectly: QueryRunner = (_sql, execute) => execute();

/** Intentional no-op used as a self-replacement target for one-shot functions. */
// intentional noop
const noop = (): void => {};

/** Resolves the database path, falling back to a default if the import fails. */
function resolveDbPath(): string {
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    // Lazy require: db/index.ts imports this module.
    const { getDbPath } = _require("./index.js") as {
      getDbPath: () => string;
    };
    return getDbPath();
  } catch {
    return "~/.sentry/cli.db";
  }
}

function warnReadonlyDatabase(): void {
  warnReadonlyDatabaseOnce = noop;

  const dbPath = resolveDbPath();
  process.stderr.write(
    `\nWarning: Sentry CLI local database is read-only. Caching and preferences won't persist.\n` +
      `  Path: ${dbPath}\n` +
      "  Fix:  sentry cli fix\n\n",
  );
}

/**
 * Print a one-time warning to stderr when the local database is read-only.
 * Replaces itself with a noop after the first call so subsequent invocations
 * are free. Assigned via `let` so the binding can be swapped.
 */
let warnReadonlyDatabaseOnce: () => void = warnReadonlyDatabase;

/** Whether we already attempted a permission repair this process. */
let repairAttempted = false;

/**
 * Chmod a path, ignoring ENOENT (file doesn't exist yet).
 * Re-throws any other error so permission failures aren't silently masked.
 */
function chmodIfExists(filePath: string, mode: number): void {
  try {
    chmodSync(filePath, mode);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Check whether the file at `filePath` is owned by root (uid 0).
 * Returns false if the file doesn't exist, can't be stat'd, or if running on
 * Windows where `fs.stat().uid` always returns 0 regardless of ownership.
 */
function isOwnedByRoot(filePath: string): boolean {
  // Windows fs.stat() always reports uid 0 — skip the check entirely.
  if (process.platform === "win32") {
    return false;
  }
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return statSync(filePath).uid === 0;
  } catch {
    return false;
  }
}

/**
 * Attempt to repair database file permissions so future commands can write.
 *
 * SQLite caches the readonly state at connection open time, so even after a
 * successful chmod the *current* connection remains readonly. This function
 * repairs permissions for the NEXT command and prints a differentiated message.
 * If the repair fails (e.g., file owned by another user) we fall through to
 * {@link warnReadonlyDatabaseOnce} which tells the user to run `sentry cli fix`.
 *
 * Only tries once per process via the `repairAttempted` guard.
 */
function tryRepairReadonly(): boolean {
  if (repairAttempted) {
    return false;
  }
  repairAttempted = true;

  const dbPath = resolveDbPath();
  const configDir = dirname(dbPath);

  // If the config dir or DB file is root-owned, chmod won't help.
  // Emit an actionable message telling the user to run sudo chown.
  if (isOwnedByRoot(configDir) || isOwnedByRoot(dbPath)) {
    const username = getRealUsername();
    // Disable the generic warning — we're emitting a better one here.
    warnReadonlyDatabaseOnce = noop;
    process.stderr.write(
      "\nWarning: Sentry CLI config directory is owned by root.\n" +
        `  Path:  ${configDir}\n` +
        `  Fix:   sudo chown -R ${username} "${configDir}"\n` +
        "  Or:    sudo sentry cli fix\n\n",
    );
    return false;
  }

  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    // Repair config directory (needs rwx for WAL/SHM creation)
    chmodSync(configDir, 0o700);

    // Repair database file and journal files
    chmodSync(dbPath, 0o600);
    chmodIfExists(`${dbPath}-wal`, 0o600);
    chmodIfExists(`${dbPath}-shm`, 0o600);

    // Disable the fallback warning — repair succeeded
    warnReadonlyDatabaseOnce = noop;

    process.stderr.write(
      "\nNote: Database permissions were auto-repaired. Caching will resume on next command.\n\n",
    );
    return true;
  } catch {
    // chmod failed — fall through so warnReadonlyDatabaseOnce fires
    return false;
  }
}

/**
 * Reset all readonly-related state (for testing).
 * @internal
 */
export function resetReadonlyWarning(): void {
  repairAttempted = false;
  warnReadonlyDatabaseOnce = warnReadonlyDatabase;
}

/** Methods on SQLite Statement that execute queries and should be wrapped */
const WRAPPED_STATEMENT_METHODS = ["get", "run", "all", "values"] as const;

/**
 * Handle a readonly database error by attempting auto-repair and returning a
 * type-appropriate no-op value. Returns `undefined` for run/get (void / no-row)
 * and `[]` for all/values (empty result set).
 *
 * First tries to repair file permissions via {@link tryRepairReadonly}. If that
 * fails (or was already attempted), falls back to a one-shot warning directing
 * the user to `sentry cli fix`.
 */
function handleReadonlyError(method: string | symbol): unknown {
  if (!tryRepairReadonly()) {
    warnReadonlyDatabaseOnce();
  }
  if (method === "all" || method === "values") {
    return [];
  }
  return;
}

/**
 * Wrap a SQLite Statement so get/run/all/values repair schema errors, skip
 * read-only writes, and run through `runQuery`.
 */
function createResilientStatement<T>(
  db: Database,
  stmt: T,
  sql: string,
  runQuery: QueryRunner,
): T {
  return new Proxy(stmt as object, {
    get(target, prop) {
      const value = Reflect.get(target, prop);

      // Non-function properties pass through directly
      if (typeof value !== "function") {
        return value;
      }

      // Other methods get bound to preserve 'this' context for native methods
      if (
        !WRAPPED_STATEMENT_METHODS.includes(
          prop as (typeof WRAPPED_STATEMENT_METHODS)[number],
        )
      ) {
        return value.bind(target);
      }

      return (...args: unknown[]) =>
        runQuery(sql, () => {
          const execute = () =>
            (value as (...a: unknown[]) => unknown).apply(target, args);

          try {
            return execute();
          } catch (error) {
            // Attempt auto-repair for schema errors
            const repairResult = tryRepairAndRetry(db, execute, error);
            if (repairResult.attempted) {
              return repairResult.result;
            }

            // Handle readonly database gracefully: warn once, skip the write.
            // The CLI still works — reads succeed, only caching/persistence is lost.
            if (isReadonlyError(error)) {
              return handleReadonlyError(prop);
            }

            // Re-throw if repair didn't help or wasn't applicable
            throw error;
          }
        });
    },
  }) as T;
}

/**
 * Wrap a SQLite Database so queries repair schema errors and skip read-only
 * writes.
 *
 * @param db - The raw SQLite Database to wrap; schema repairs run on it
 * @param runQuery - Runs each statement execution, e.g. inside a span
 * @returns A proxied Database
 */
export function createResilientDatabase(
  db: Database,
  runQuery: QueryRunner = runDirectly,
): Database {
  const originalQuery = db.query.bind(db);

  return new Proxy(db as object, {
    get(target, prop) {
      if (prop === "query") {
        return (sql: string) => {
          // Try to prepare the statement, with auto-repair on schema errors
          const prepareStatement = () => originalQuery(sql);

          let stmt: ReturnType<Database["query"]>;
          try {
            stmt = prepareStatement();
          } catch (error) {
            // Attempt auto-repair for schema errors during statement preparation
            const repairResult = tryRepairAndRetry(db, prepareStatement, error);
            if (repairResult.attempted) {
              stmt = repairResult.result;
            } else {
              throw error;
            }
          }

          return createResilientStatement(db, stmt, sql, runQuery);
        };
      }
      const value = Reflect.get(target, prop);
      // Bind methods to preserve 'this' context for native methods with private fields
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as Database;
}
