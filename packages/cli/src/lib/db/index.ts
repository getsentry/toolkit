/**
 * SQLite database connection manager for CLI configuration storage.
 * Uses the sqlite.ts adapter, which selects `node:sqlite` (Node 22.15+) or a
 * bundled WASM driver (`node-sqlite3-wasm`, Node < 22.15) behind one API.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { DB_FILENAME, resolveConfigDir } from "../config-dir.js";
import { getEnv } from "../env.js";
import { logger } from "../logger.js";

const _require = createRequire(import.meta.url);

const log = logger.withTag("db");

import { migrateFromJson } from "./migration.js";
import { createResilientDatabase } from "./resilient.js";
import { initSchema, runMigrations } from "./schema.js";
import { Database } from "./sqlite.js";

export {
  CONFIG_DIR_ENV_VAR,
  DEFAULT_CONFIG_DIR_DISPLAY,
  resolveConfigDir,
  resolveXdgConfigDir,
} from "../config-dir.js";

/** 7-day TTL for cache entries (milliseconds) */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Probability of running cleanup on write operations */
const CLEANUP_PROBABILITY = 0.1;

/** Wrapped database (returned by getDatabase) */
let db: Database | null = null;
/** Raw, unwrapped database (used for repair operations) */
let rawDb: Database | null = null;
let dbOpenedPath: string | null = null;
/**
 * Set once {@link detachDatabase} hands `cli.db` to another CLI version.
 * Later reads in this process use a throwaway in-memory database instead.
 */
let detached = false;

/**
 * Whether the process-exit close handler has been registered.
 *
 * On the WASM fallback (`node-sqlite3-wasm`, Node < 22.15), the driver
 * releases its `<db>.lock` mutex during `close()` — the adapter's `.get()`
 * wrapper finalizes cursors so this happens reliably. Explicitly closing on
 * a normal `exit` is a proactive backstop that shrinks the window in which a
 * lock could linger; it does NOT fire on SIGKILL/SIGINT, so it is not the
 * primary guarantee. A lock orphaned by a signal-killed process is recovered
 * at the next open by `clearStaleWasmLock`, which uses the PID-owner sentinel
 * to clear it immediately once the owner is gone. Harmless (and cheap) for the
 * native driver too.
 */
let exitHandlerRegistered = false;

function registerExitHandler(): void {
  if (exitHandlerRegistered) {
    return;
  }
  exitHandlerRegistered = true;
  // 'exit' handlers must be synchronous; close() is synchronous.
  process.on("exit", () => {
    try {
      db?.close();
    } catch (error) {
      // Best-effort: the process is exiting anyway. A failed close here
      // must never mask the real exit code.
      log.debug("Failed to close database on exit", error);
    }
  });
}

export function getConfigDir(): string {
  return resolveConfigDir(getEnv(), homedir());
}

export function getDbPath(): string {
  return join(getConfigDir(), DB_FILENAME);
}

/** Create the config directory, owner-only, if needed, and return its path. */
export function ensureConfigDir(): string {
  const directory = getConfigDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function setDbPermissions(): void {
  const dbPath = getDbPath();
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    chmodSync(dbPath, 0o600);
    // WAL mode creates -wal and -shm files that may contain sensitive data
    // Chmod them too if they exist (they may not exist on first run)
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      chmodSync(`${dbPath}-wal`, 0o600);
    } catch {
      // File may not exist yet
    }
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      chmodSync(`${dbPath}-shm`, 0o600);
    } catch {
      // File may not exist yet
    }
  } catch {
    // Windows doesn't support chmod
  }
}

/** Get or initialize the database connection. */
export function getDatabase(): Database {
  const dbPath = detached ? ":memory:" : getDbPath();

  // Auto-invalidate if config directory changed (for tests)
  if (db && dbOpenedPath !== dbPath) {
    db.close();
    db = null;
    rawDb = null;
    dbOpenedPath = null;
  }

  if (db) {
    return db;
  }

  if (!detached) {
    ensureConfigDir();
  }

  rawDb = new Database(dbPath);

  try {
    // 5000ms busy_timeout prevents SQLITE_BUSY errors during concurrent CLI access.
    // When multiple CLI instances run simultaneously (e.g., parallel terminals, CI jobs),
    // SQLite needs time to acquire locks. WAL mode allows concurrent reads, but writers
    // must wait. Without sufficient timeout, concurrent processes fail immediately.
    // Set busy_timeout FIRST - before WAL mode - to handle lock contention during init.
    rawDb.exec("PRAGMA busy_timeout = 5000");
    // WAL is only supported by the native node:sqlite driver. The WASM fallback
    // (Node < 22.15) silently ignores it and stays in the default rollback
    // journal — acceptable for a single-process CLI cache — so skip the no-op
    // pragma there rather than pretend it took effect.
    if (rawDb.driverKind === "node") {
      rawDb.exec("PRAGMA journal_mode = WAL");
    }
    rawDb.exec("PRAGMA foreign_keys = ON");
    rawDb.exec("PRAGMA synchronous = NORMAL");

    if (!detached) {
      setDbPermissions();
    }
    initSchema(rawDb);
    runMigrations(rawDb);
    if (!detached) {
      migrateFromJson(rawDb);
    }

    // Both wrappers repair schema errors and skip read-only writes; the traced
    // one also adds query spans when telemetry is on.
    db =
      lazyTelemetry()?.createTracedDatabase(rawDb) ??
      createResilientDatabase(rawDb);
    dbOpenedPath = dbPath;
    registerExitHandler();

    return db;
  } catch (error) {
    // Clean up on initialization failure to prevent connection leak
    rawDb.close();
    rawDb = null;
    throw error;
  }
}

/**
 * `true` in the npm package's `dist/complete.cjs` (defined in
 * `script/bundle.ts`), so esbuild drops the telemetry `require` below from
 * that bundle. Undefined when running from source.
 */
declare const SENTRY_CLI_COMPLETION_BUILD: boolean | undefined;

/**
 * The telemetry module, required lazily so the database modules never import
 * `@sentry/node` (~100ms). `undefined` when telemetry is off: the `__complete`
 * fast path sets `SENTRY_CLI_NO_TELEMETRY=1` and never loads it.
 */
function lazyTelemetry(): typeof import("../telemetry.js") | undefined {
  if (
    (typeof SENTRY_CLI_COMPLETION_BUILD !== "undefined" &&
      SENTRY_CLI_COMPLETION_BUILD) ||
    getEnv().SENTRY_CLI_NO_TELEMETRY === "1"
  ) {
    return;
  }
  return _require("../telemetry.js") as typeof import("../telemetry.js");
}

/** Run a database operation in a `db.operation` span (telemetry's `withDbSpan`). */
export function withDbSpan<T>(operation: string, fn: () => T): T {
  const telemetry = lazyTelemetry();
  return telemetry ? telemetry.withDbSpan(operation, fn) : fn();
}

/** Record a cache hit or miss (telemetry's `recordCacheHit`). */
export function recordCacheHit(cacheName: string, hit: boolean): void {
  lazyTelemetry()?.recordCacheHit(cacheName, hit);
}

/** Close the database connection (used for testing). */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    rawDb = null;
    dbOpenedPath = null;
  }
  detached = false;
}

/**
 * Close `cli.db` for good in this process, so another CLI version can own it.
 *
 * Used when `sentry cli upgrade undo` swaps in an older version's database:
 * reopening it here would migrate it to this version's schema. Later reads
 * get a fresh in-memory database, so their writes are dropped.
 */
export function detachDatabase(): void {
  closeDatabase();
  detached = true;
}

/**
 * Get the raw (unwrapped) database connection.
 * Used for repair operations to avoid triggering the traced wrapper's
 * auto-repair logic (which would cause infinite loops).
 */
export function getRawDatabase(): Database {
  if (!rawDb) {
    // Ensure database is initialized
    getDatabase();
  }
  // After getDatabase() call, rawDb is guaranteed to be set
  if (!rawDb) {
    throw new Error("Database initialization failed");
  }
  return rawDb;
}

function shouldRunCleanup(): boolean {
  return Math.random() < CLEANUP_PROBABILITY;
}

function cleanupExpiredCaches(): void {
  const database = getDatabase();
  const expiryTime = Date.now() - CACHE_TTL_MS;
  const now = Date.now();

  database
    .query("DELETE FROM project_cache WHERE last_accessed < ?")
    .run(expiryTime);
  database
    .query("DELETE FROM dsn_cache WHERE last_accessed < ?")
    .run(expiryTime);
  database
    .query("DELETE FROM project_aliases WHERE last_accessed < ?")
    .run(expiryTime);
  database
    .query("DELETE FROM completion_cache WHERE last_seen < ?")
    .run(expiryTime);
  // project_root_cache uses ttl_expires_at instead of last_accessed
  database
    .query("DELETE FROM project_root_cache WHERE ttl_expires_at < ?")
    .run(now);
}

export function maybeCleanupCaches(): void {
  if (shouldRunCleanup()) {
    cleanupExpiredCaches();
  }
}
