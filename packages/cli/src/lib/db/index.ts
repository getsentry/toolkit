/**
 * SQLite database connection manager for CLI configuration storage.
 * Uses the sqlite.ts adapter, which selects `node:sqlite` (Node 22.15+) or a
 * bundled WASM driver (`node-sqlite3-wasm`, Node < 22.15) behind one API.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getEnv } from "../env.js";
import { logger } from "../logger.js";

const _require = createRequire(import.meta.url);

const log = logger.withTag("db");

import { migrateFromJson } from "./migration.js";
import { initSchema, runMigrations } from "./schema.js";
import { Database } from "./sqlite.js";

export const CONFIG_DIR_ENV_VAR = "SENTRY_CONFIG_DIR";

/** Legacy config directory name under the user's home directory (`~/.sentry`). */
const LEGACY_CONFIG_DIR_NAME = ".sentry";

/** Sub-directory used under the XDG config base directory. */
const XDG_CONFIG_SUBDIR = "sentry";

const DB_FILENAME = "cli.db";

/** 7-day TTL for cache entries (milliseconds) */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Probability of running cleanup on write operations */
const CLEANUP_PROBABILITY = 0.1;

/** Traced database wrapper (returned by getDatabase) */
let db: Database | null = null;
/** Raw database without tracing (used for repair operations) */
let rawDb: Database | null = null;
let dbOpenedPath: string | null = null;

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

/**
 * Resolve the config directory from an environment and home directory.
 *
 * Precedence:
 * 1. `SENTRY_CONFIG_DIR` — explicit override, always wins.
 * 2. Legacy `~/.sentry` — used when it already exists, so existing installs
 *    keep working without migration.
 * 3. XDG base directory — `$XDG_CONFIG_HOME/sentry`, falling back to
 *    `~/.config/sentry`. Per the XDG spec, a non-absolute `XDG_CONFIG_HOME`
 *    is ignored.
 *
 * Pure and side-effect free so it can be unit-tested directly.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env[CONFIG_DIR_ENV_VAR];
  if (override) {
    return override;
  }

  const legacyDir = join(home, LEGACY_CONFIG_DIR_NAME);
  // Only treat the legacy directory as a prior config install when it
  // contains the actual database or the old JSON config. A bare
  // `~/.sentry/bin` created by the curl installer should not block XDG.
  if (
    existsSync(legacyDir) &&
    (existsSync(join(legacyDir, DB_FILENAME)) ||
      existsSync(join(legacyDir, "config.json")))
  ) {
    return legacyDir;
  }

  return resolveXdgConfigDir(env, home);
}

/**
 * Resolve the XDG-compliant config directory, ignoring any legacy `~/.sentry`
 * install. This is the migration *target*: `resolveConfigDir` keeps returning
 * the legacy dir while it holds `cli.db`, so migration must compute the new
 * location directly. Honors `SENTRY_CONFIG_DIR` and an absolute
 * `XDG_CONFIG_HOME`, otherwise defaults to `~/.config/sentry`.
 */
export function resolveXdgConfigDir(
  env: NodeJS.ProcessEnv,
  home: string
): string {
  const override = env[CONFIG_DIR_ENV_VAR];
  if (override) {
    return override;
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const configHome =
    xdgConfigHome && isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : join(home, ".config");
  return join(configHome, XDG_CONFIG_SUBDIR);
}

export function getConfigDir(): string {
  return resolveConfigDir(getEnv(), homedir());
}

export function getDbPath(): string {
  return join(getConfigDir(), DB_FILENAME);
}

function ensureConfigDir(): void {
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
}

function setDbPermissions(): void {
  const dbPath = getDbPath();
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    chmodSync(dbPath, 0o600);
    // WAL mode creates -wal and -shm files that may contain sensitive data
    // Chmod them too if they exist (they may not exist on first run)
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      chmodSync(`${dbPath}-wal`, 0o600);
    } catch {
      // File may not exist yet
    }
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
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
  const dbPath = getDbPath();

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

  ensureConfigDir();

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

    setDbPermissions();
    initSchema(rawDb);
    runMigrations(rawDb);
    migrateFromJson(rawDb);

    // Wrap with tracing proxy for automatic query instrumentation.
    // Lazy-require telemetry to avoid top-level import of @sentry/node-core (~85ms).
    // Shell completions set SENTRY_CLI_NO_TELEMETRY=1 to skip this entirely.
    if (getEnv().SENTRY_CLI_NO_TELEMETRY === "1") {
      db = rawDb;
    } else {
      const { createTracedDatabase } = _require("../telemetry.js") as {
        createTracedDatabase: (d: Database) => Database;
      };
      db = createTracedDatabase(rawDb);
    }
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

/** Close the database connection (used for testing). */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    rawDb = null;
    dbOpenedPath = null;
  }
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
