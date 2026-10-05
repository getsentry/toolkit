/**
 * SQLite adapter providing a unified API.
 *
 * This module is the single import point for all SQLite access in the
 * codebase. It provides a `.query(sql).get()` / `.all()` / `.run()`
 * interface and a manual `transaction()` wrapper.
 *
 * Two backing drivers are supported and selected at runtime:
 *
 * - **`node:sqlite`** (`DatabaseSync`) on Node.js 22.15+ — the built-in,
 *   native driver. This is the fast path used by the standalone binary
 *   (which always embeds a modern LTS Node.js) and by modern npm installs.
 * - **`node-sqlite3-wasm`** on Node.js 18–22.14 — a pure-WASM fallback so
 *   the npm package works on older runtimes that lack `node:sqlite`. It is
 *   lazily `require()`d only in the fallback branch, which lets the binary
 *   build externalize (and therefore drop) it entirely.
 *
 * The two drivers have subtly different APIs; this adapter normalises them
 * behind a single surface. See {@link wrapStatement} for the parameter and
 * return-value differences that are reconciled here.
 */

import {
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { logger } from "../logger.js";
import { isProcessRunning } from "../process-utils.js";

const _require = createRequire(import.meta.url);

const log = logger.withTag("sqlite");

/** Valid SQLite binding value. */
export type SQLQueryBindings =
  | string
  | number
  | bigint
  | boolean
  | null
  | Uint8Array
  | undefined;

/**
 * Which backing SQLite driver is active.
 *
 * - `"node"` — `node:sqlite` `DatabaseSync` (Node.js 22.15+).
 * - `"wasm"` — `node-sqlite3-wasm` (Node.js 18–22.14 fallback).
 */
type DriverKind = "node" | "wasm";

/**
 * Minimum Node.js version that ships a usable built-in `node:sqlite`
 * (`DatabaseSync`). Below this the WASM fallback is used.
 */
const NODE_SQLITE_MIN_MAJOR = 22;
const NODE_SQLITE_MIN_MINOR = 15;

/**
 * Prepared statement wrapper exposing `.get()`, `.all()`, `.run()`.
 *
 * Uses a Proxy to pass through any additional methods while normalising
 * `.get()` to return `null` (not `undefined`) for no-row results.
 */
type StatementWrapper = {
  get(...params: SQLQueryBindings[]): Record<string, SQLQueryBindings> | null;
  all(...params: SQLQueryBindings[]): Record<string, SQLQueryBindings>[];
  run(...params: SQLQueryBindings[]): void;
  [method: string]: unknown;
};

/**
 * Coerce a single bind value to a form both drivers accept.
 *
 * `node:sqlite` rejects JS booleans ("Provided value cannot be bound") while
 * `node-sqlite3-wasm` accepts them — normalise `boolean` → `0|1` for both so
 * the exported {@link SQLQueryBindings} `boolean` option behaves identically
 * regardless of runtime. `undefined` → `null` (the WASM driver rejects
 * `undefined`; `node:sqlite` callers never pass it).
 */
function normalizeBind(value: SQLQueryBindings): SQLQueryBindings {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value === undefined) {
    return null;
  }
  return value;
}

/**
 * Normalise positional bind parameters for the WASM driver.
 *
 * `node-sqlite3-wasm` expects a single array of bind values (`run([a, b])`),
 * whereas `node:sqlite` expects spread arguments (`run(a, b)`). Values are
 * also passed through {@link normalizeBind}.
 */
function toWasmParams(params: SQLQueryBindings[]): SQLQueryBindings[] {
  return params.map(normalizeBind);
}

/** Apply {@link normalizeBind} to spread params for the native driver. */
function toNodeParams(params: SQLQueryBindings[]): SQLQueryBindings[] {
  return params.map(normalizeBind);
}

/**
 * Wrap a driver-native prepared statement in the unified {@link StatementWrapper}.
 *
 * Reconciles the two drivers' calling conventions:
 * - **params**: `node:sqlite` takes spread args; `node-sqlite3-wasm` takes a
 *   single array. We branch on `kind` so callers can always use spread.
 * - **`.get()` no-row result**: both are normalised to `null`
 *   (`node:sqlite` returns `undefined`).
 *
 * @param stmt Driver-native statement (`node:sqlite` Statement or
 *   `node-sqlite3-wasm` Statement).
 * @param kind Which driver produced `stmt`.
 */
// biome-ignore lint/suspicious/noExplicitAny: backing driver types vary
function wrapStatement(stmt: any, kind: DriverKind): StatementWrapper {
  return new Proxy(stmt, {
    get(target, prop) {
      if (prop === "get") {
        return (...params: SQLQueryBindings[]) => {
          if (kind === "wasm") {
            const row = target.get(toWasmParams(params));
            // node-sqlite3-wasm leaves the statement's cursor open after a
            // single-row read, which keeps the SQLite lock held. That lock
            // (an on-disk `<db>.lock` mutex) then survives `Database.close()`
            // via close_v2's deferred-close, leaking a lock dir that blocks
            // the next process. Finalizing here releases the cursor so the
            // driver's own close-time unlock removes only *our* lock. (`.all()`
            // and `.run()` read to completion and auto-reset, so they don't
            // need this.) Guarded so a reused statement never double-finalizes.
            if (!target.isFinalized) {
              target.finalize();
            }
            return (row as Record<string, SQLQueryBindings>) ?? null;
          }
          const row = target.get(...toNodeParams(params));
          // Normalise no-row result to null (node:sqlite returns undefined).
          return (row as Record<string, SQLQueryBindings>) ?? null;
        };
      }
      if (prop === "all") {
        return (...params: SQLQueryBindings[]) =>
          kind === "wasm"
            ? target.all(toWasmParams(params))
            : target.all(...toNodeParams(params));
      }
      if (prop === "run") {
        return (...params: SQLQueryBindings[]) =>
          kind === "wasm"
            ? target.run(toWasmParams(params))
            : target.run(...toNodeParams(params));
      }
      const value = Reflect.get(target, prop);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as StatementWrapper;
}

/** Backing-driver constructor plus which kind it is. */
type ResolvedDriver = {
  // biome-ignore lint/suspicious/noExplicitAny: driver constructors differ
  Ctor: any;
  kind: DriverKind;
};

/**
 * Whether the current runtime provides a usable built-in `node:sqlite`.
 *
 * Bun sets `process.versions.node` to a compat version but does not ship
 * `node:sqlite`; the try/catch in {@link resolveDriver} is the ultimate
 * guard, this is just the fast happy-path check.
 */
function hasNativeNodeSqlite(): boolean {
  const [major = 0, minor = 0] = process.versions.node
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  if (major > NODE_SQLITE_MIN_MAJOR) {
    return true;
  }
  return major === NODE_SQLITE_MIN_MAJOR && minor >= NODE_SQLITE_MIN_MINOR;
}

let resolvedDriver: ResolvedDriver | null = null;

/**
 * Test-only override for which driver {@link resolveDriver} returns.
 * `null` means "use normal runtime detection".
 * @internal
 */
let forcedDriverKind: DriverKind | null = null;

/**
 * Force a specific backing driver for the next connection(s), or reset to
 * automatic detection with `null`. Clears the memoised resolution so the
 * change takes effect immediately.
 *
 * Intended for tests that need to exercise the WASM fallback on a modern
 * Node.js (where native `node:sqlite` would otherwise be chosen).
 *
 * @internal
 */
export function __setDriverForTests(kind: DriverKind | null): void {
  forcedDriverKind = kind;
  resolvedDriver = null;
}

/**
 * Resolve the SQLite database constructor for the current runtime.
 *
 * Prefers native `node:sqlite` (`DatabaseSync`); falls back to the bundled
 * `node-sqlite3-wasm` on older Node.js. Memoised after first resolution.
 *
 * The WASM driver is `require()`d only inside the fallback branch. The
 * standalone binary build (`script/build.ts`) marks `node-sqlite3-wasm`
 * external, so this branch is dead code there and adds zero bytes to the
 * SEA binary (which always runs Node.js ≥ 22.15).
 */
function resolveDriver(): ResolvedDriver {
  if (resolvedDriver) {
    return resolvedDriver;
  }

  if (
    forcedDriverKind === "node" ||
    (!forcedDriverKind && hasNativeNodeSqlite())
  ) {
    try {
      resolvedDriver = {
        Ctor: _require("node:sqlite").DatabaseSync,
        kind: "node",
      };
      return resolvedDriver;
    } catch (error) {
      // When the native driver was *explicitly* requested (tests), silently
      // swapping to WASM would run against the wrong backend and mask failures.
      // Only auto-fall-through when the choice was ours (version-based).
      if (forcedDriverKind === "node") {
        throw error;
      }
      // node:sqlite genuinely unavailable despite the version check
      // (e.g. Bun, or a Node build without SQLite). Fall through to WASM.
      log.debug("node:sqlite unavailable, falling back to WASM driver", error);
    }
  }

  const { Database: WasmDatabase } = _require("node-sqlite3-wasm") as {
    // biome-ignore lint/suspicious/noExplicitAny: driver types loaded lazily
    Database: any;
  };
  resolvedDriver = { Ctor: WasmDatabase, kind: "wasm" };
  return resolvedDriver;
}

/**
 * Fallback age (ms) beyond which a `<db>.lock` directory with no usable PID
 * sentinel is treated as stale.
 *
 * The WASM driver acquires the lock (`mkdir`) for the duration of a write and
 * releases it (`rmdir`) when SQLite drops to lock level NONE; while held, the
 * directory's mtime is frozen at acquisition time (the driver never re-touches
 * it). A held lock therefore ages, so a pure time threshold cannot by itself
 * distinguish "long-running live writer" from "orphaned by a dead process" —
 * that is what the PID sentinel is for. This age check is only the fallback
 * for locks with no readable sentinel (e.g. left by an older CLI version); it
 * is kept generously large so it never races a plausibly-live writer.
 */
const STALE_LOCK_MAX_AGE_MS = 60_000;

/**
 * Minimum age (ms) before a lock may be removed *at all*, even when the PID
 * sentinel says its owner is dead.
 *
 * The sentinel is a single shared file, so it can be stale: a leftover
 * `.lock.owner` naming a dead PID may sit next to a lock that a *different*,
 * still-live process (e.g. an older CLI that doesn't write sentinels) just
 * acquired. Refusing to delete any lock younger than this floor guarantees we
 * never steal a freshly-acquired live lock on the strength of a stale
 * sentinel. It is comfortably larger than a single write's lock hold (sub-ms
 * to a few ms) but small enough that Ctrl+C recovery is near-instant instead
 * of the old 60s wait.
 */
const LOCK_SAFETY_FLOOR_MS = 3000;

/**
 * Sibling file recording the PID of the process that most recently opened the
 * DB on the WASM path. Lets a later invocation test whether a leftover
 * `<db>.lock` belongs to a still-running process or an orphan. Kept *outside*
 * the lock directory itself: a file inside it would make the driver's
 * `rmdir`-based unlock fail, defeating the driver's own cleanup.
 */
function lockOwnerPath(dbPath: string): string {
  return `${dbPath}.lock.owner`;
}

/**
 * Remove a stale lock directory left by a previous `node-sqlite3-wasm`
 * process.
 *
 * The WASM driver implements SQLite file locking by `mkdir("<db>.lock")`
 * (an atomic mutex) and releasing it with `rmdir` only when SQLite lowers
 * the lock to NONE. If a process is killed (SIGINT/SIGKILL) while holding a
 * lock — bypassing our normal close — the empty directory is left behind, and
 * the next invocation's `mkdir` fails with EEXIST, surfacing as "database is
 * locked".
 *
 * Removal is deliberately conservative — it never deletes a lock that could
 * still be live:
 *  - A lock younger than {@link LOCK_SAFETY_FLOOR_MS} is always kept, even if a
 *    (possibly stale) sentinel names a dead PID. This stops a leftover sentinel
 *    from stealing a lock another process just acquired.
 *  - Past that floor, a dead-owner sentinel means the lock is provably orphaned
 *    → clear it immediately (near-instant Ctrl+C recovery).
 *  - A live-owner sentinel means a genuine live lock → keep it (contention is
 *    left to SQLite's `busy_timeout`).
 *  - With no readable sentinel we fall back to the {@link STALE_LOCK_MAX_AGE_MS}
 *    age heuristic.
 *
 * Only the empty lock directory is removed (`rmdir` leaves a non-empty dir
 * intact). Best-effort: any failure is swallowed so a permissions issue or a
 * genuine race degrades to the driver's own locking error rather than a crash.
 */
function clearStaleWasmLock(dbPath: string): void {
  if (dbPath === ":memory:" || dbPath === "") {
    return;
  }
  const lockDir = `${dbPath}.lock`;
  try {
    const stat = statSync(lockDir); // throws ENOENT when no lock — common case
    const age = Date.now() - stat.mtimeMs;

    // Safety floor: too fresh to touch. A lock this young may have just been
    // acquired by a live peer, and a stale sentinel must not override that.
    if (age < LOCK_SAFETY_FLOOR_MS) {
      return;
    }

    const owner = readLockOwner(dbPath);
    if (owner !== null) {
      if (isProcessRunning(owner)) {
        // Owner still running: a genuine live lock. Leave it to busy_timeout.
        return;
      }
      // Owner dead and lock past the safety floor: provably orphaned.
    } else if (age < STALE_LOCK_MAX_AGE_MS) {
      // No sentinel to prove death; not old enough for the age fallback.
      return;
    }

    // rmdirSync only removes empty directories, so this can never delete a
    // lock actively held with contents (this driver's locks are always empty).
    rmdirSync(lockDir);
    log.debug(`Cleared orphaned WASM SQLite lock: ${lockDir}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: no stale lock (the common case). Anything else is logged.
    if (code !== "ENOENT") {
      log.debug("Could not clear stale WASM SQLite lock", error);
    }
  }
}

/**
 * Record the current process as the WASM lock owner (best-effort).
 * Written on open so a later invocation can test our liveness if we're killed
 * mid-write before {@link removeLockOwner} runs.
 */
function writeLockOwner(dbPath: string): void {
  if (dbPath === ":memory:" || dbPath === "") {
    return;
  }
  try {
    writeFileSync(lockOwnerPath(dbPath), String(process.pid));
  } catch (error) {
    log.debug("Could not write WASM lock owner sentinel", error);
  }
}

/** Read the recorded owner PID, or null if absent/unreadable. */
function readLockOwner(dbPath: string): number | null {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const pid = Number.parseInt(
      readFileSync(lockOwnerPath(dbPath), "utf8"),
      10
    );
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Remove our owner sentinel on clean close (best-effort). */
function removeLockOwner(dbPath: string): void {
  if (dbPath === ":memory:" || dbPath === "") {
    return;
  }
  try {
    rmSync(lockOwnerPath(dbPath), { force: true });
  } catch (error) {
    log.debug("Could not remove WASM lock owner sentinel", error);
  }
}

/**
 * SQLite database wrapper.
 *
 * - `exec(sql)` — execute raw SQL (DDL, multi-statement)
 * - `query(sql)` — prepare a statement → `.get()` / `.all()` / `.run()`
 * - `close()` — close the connection
 * - `transaction(fn)` — wrap a function in BEGIN/COMMIT/ROLLBACK
 */
export class Database {
  // biome-ignore lint/suspicious/noExplicitAny: backing driver resolved at runtime
  private readonly db: any;

  /** Which backing driver this instance uses (for param normalisation). */
  private readonly kind: DriverKind;

  /** On-disk path (for WASM lock-owner sentinel cleanup on close). */
  private readonly path: string;

  constructor(path: string) {
    const { Ctor, kind } = resolveDriver();
    if (kind === "wasm") {
      clearStaleWasmLock(path);
    }
    this.db = new Ctor(path);
    this.kind = kind;
    this.path = path;
    if (kind === "wasm") {
      // Record ourselves so a later invocation can tell whether a leftover
      // lock (e.g. after we're SIGINT-killed mid-write) is orphaned or live.
      writeLockOwner(path);
    }
  }

  /**
   * Which backing SQLite driver is active (`"node"` or `"wasm"`).
   *
   * Callers use this to skip pragmas the WASM driver doesn't support (e.g.
   * `journal_mode = WAL`, which it silently ignores).
   */
  get driverKind(): DriverKind {
    return this.kind;
  }

  /** Execute raw SQL (DDL statements, multi-statement strings). */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Prepare a SQL statement.
   * Returns a wrapper with `.get()`, `.all()`, `.run()`.
   */
  query(sql: string): StatementWrapper {
    return wrapStatement(this.db.prepare(sql), this.kind);
  }

  /**
   * Close the database connection.
   *
   * On the WASM path the driver releases its own `<db>.lock` mutex during
   * close, provided no statement cursor is still open — which the `.get()`
   * wrapper guarantees by finalizing after each single-row read. We do NOT
   * remove the lock directory ourselves here: `<db>.lock` is a path-keyed
   * cross-process mutex, so a stray `rmdir` could delete a concurrently-
   * running CLI's live lock and allow two writers at once (corruption). Stale
   * locks left by a crashed process are handled at open time by
   * {@link clearStaleWasmLock}. We do clear our own owner sentinel so it can't
   * linger and be misread by a later invocation.
   */
  close(): void {
    this.db.close();
    if (this.kind === "wasm") {
      removeLockOwner(this.path);
    }
  }

  /**
   * Wrap a function in a transaction. Returns a callable that executes
   * the function within BEGIN/COMMIT, with ROLLBACK on error.
   *
   * Neither `node:sqlite` nor `node-sqlite3-wasm` exposes a native
   * `transaction()` helper, so this always uses the manual wrapper.
   */
  transaction<T>(fn: () => T): () => T {
    if (typeof this.db.transaction === "function") {
      return this.db.transaction(fn);
    }
    return () => {
      this.db.exec("BEGIN");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch (rollbackError) {
          log.debug("ROLLBACK failed after transaction error", rollbackError);
        }
        throw error;
      }
    };
  }
}
