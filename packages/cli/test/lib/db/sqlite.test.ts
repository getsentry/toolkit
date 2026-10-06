/**
 * Tests for the dual-driver SQLite adapter.
 *
 * The adapter selects `node:sqlite` (Node.js 22.15+) or `node-sqlite3-wasm`
 * (older Node.js) at runtime. The two drivers have opposite parameter
 * conventions — `node:sqlite` takes spread args, `node-sqlite3-wasm` takes a
 * single array — so these tests run the *same* adapter-level operations
 * against *both* backing drivers to prove the normalisation in
 * `wrapStatement`/`toWasmParams` keeps callers driver-agnostic.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { __setDriverForTests, Database } from "../../../src/lib/db/sqlite.js";

type DriverKind = "node" | "wasm";

const DRIVERS: DriverKind[] = ["node", "wasm"];

/**
 * Find a PID with no running process, searching downward from a high value.
 * Used to simulate a lock left by a since-exited (dead) process.
 */
function findDeadPid(): number {
  for (let pid = 0x7f_ff_ff_ff; pid > 1; pid -= 7919) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return pid;
      }
    }
  }
  // Fallback: an unlikely-but-not-guaranteed PID.
  return 0x7f_ff_ff_ff;
}

afterEach(() => {
  // Always return to automatic detection so we don't leak forced state.
  __setDriverForTests(null);
});

describe.each(DRIVERS)("sqlite adapter [%s driver]", (kind) => {
  function open(): Database {
    __setDriverForTests(kind);
    return new Database(":memory:");
  }

  test("reports its own driver kind", () => {
    const db = open();
    expect(db.driverKind).toBe(kind);
    db.close();
  });

  test("run + get roundtrips positional params", () => {
    const db = open();
    db.exec("CREATE TABLE t (a TEXT, b INTEGER)");
    db.query("INSERT INTO t (a, b) VALUES (?, ?)").run("hello", 42);

    const row = db.query("SELECT a, b FROM t WHERE b = ?").get(42);
    expect(row).toEqual({ a: "hello", b: 42 });
    db.close();
  });

  test("get returns null (not undefined) for no rows", () => {
    const db = open();
    db.exec("CREATE TABLE t (a TEXT)");
    const row = db.query("SELECT a FROM t WHERE a = ?").get("missing");
    expect(row).toBeNull();
    db.close();
  });

  test("all returns every matching row", () => {
    const db = open();
    db.exec("CREATE TABLE t (a TEXT, b INTEGER)");
    const insert = db.query("INSERT INTO t (a, b) VALUES (?, ?)");
    insert.run("x", 1);
    insert.run("y", 2);

    const rows = db.query("SELECT a, b FROM t ORDER BY b").all();
    expect(rows).toEqual([
      { a: "x", b: 1 },
      { a: "y", b: 2 },
    ]);
    db.close();
  });

  test("multiple positional params bind in order (no silent misbinding)", () => {
    // Regression guard: node-sqlite3-wasm treats a 2nd spread arg as an
    // options object, silently dropping the bind. The adapter must convert
    // spread args to an array for the WASM driver.
    const db = open();
    db.exec("CREATE TABLE t (a TEXT, b INTEGER, c TEXT)");
    db.query("INSERT INTO t (a, b, c) VALUES (?, ?, ?)").run(
      "first",
      99,
      "last"
    );

    const row = db.query("SELECT a, b, c FROM t").get();
    expect(row).toEqual({ a: "first", b: 99, c: "last" });
    db.close();
  });

  test("undefined bind is treated as null", () => {
    const db = open();
    db.exec("CREATE TABLE t (a TEXT, b INTEGER)");
    // node:sqlite rejects undefined; the adapter maps undefined→null for the
    // WASM driver. For the node driver, passing null explicitly is the
    // equivalent caller contract.
    if (kind === "wasm") {
      db.query("INSERT INTO t (a, b) VALUES (?, ?)").run("u", undefined);
      const row = db.query("SELECT a, b FROM t").get();
      expect(row).toEqual({ a: "u", b: null });
    } else {
      db.query("INSERT INTO t (a, b) VALUES (?, ?)").run("u", null);
      const row = db.query("SELECT a, b FROM t").get();
      expect(row).toEqual({ a: "u", b: null });
    }
    db.close();
  });

  test("transaction commits on success", () => {
    const db = open();
    db.exec("CREATE TABLE t (a INTEGER)");
    const insertTwo = db.transaction(() => {
      db.query("INSERT INTO t (a) VALUES (?)").run(1);
      db.query("INSERT INTO t (a) VALUES (?)").run(2);
    });
    insertTwo();

    const rows = db.query("SELECT a FROM t ORDER BY a").all();
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
    db.close();
  });

  test("transaction rolls back on error", () => {
    const db = open();
    db.exec("CREATE TABLE t (a INTEGER)");
    db.query("INSERT INTO t (a) VALUES (?)").run(1);

    const boom = db.transaction(() => {
      db.query("INSERT INTO t (a) VALUES (?)").run(2);
      throw new Error("boom");
    });
    expect(boom).toThrow("boom");

    // The row inserted before the throw must be rolled back.
    const rows = db.query("SELECT a FROM t").all();
    expect(rows).toEqual([{ a: 1 }]);
    db.close();
  });

  test("blob (Uint8Array) roundtrips", () => {
    const db = open();
    db.exec("CREATE TABLE t (data BLOB)");
    const blob = new Uint8Array([1, 2, 3, 255]);
    db.query("INSERT INTO t (data) VALUES (?)").run(blob);

    const row = db.query("SELECT data FROM t").get() as {
      data: Uint8Array;
    };
    expect(Array.from(row.data)).toEqual([1, 2, 3, 255]);
    db.close();
  });

  test("boolean binds are coerced to 0/1 on both drivers", () => {
    // node:sqlite rejects raw booleans; the adapter coerces to integers so the
    // SQLQueryBindings `boolean` option behaves identically across runtimes.
    const db = open();
    db.exec("CREATE TABLE t (flag INTEGER)");
    db.query("INSERT INTO t (flag) VALUES (?)").run(true);
    db.query("INSERT INTO t (flag) VALUES (?)").run(false);

    const rows = db.query("SELECT flag FROM t ORDER BY rowid").all();
    expect(rows).toEqual([{ flag: 1 }, { flag: 0 }]);
    db.close();
  });

  test("bigint binds within safe-integer range roundtrip", () => {
    // The CLI only ever stores integers well within Number.MAX_SAFE_INTEGER
    // (e.g. millisecond timestamps ~1.7e12). Values beyond that diverge
    // between drivers (node:sqlite throws unless BigInt mode is enabled), so
    // we deliberately stay in the safe range that both drivers agree on.
    const db = open();
    db.exec("CREATE TABLE t (n INTEGER)");
    const big = 1_700_000_000_000n; // realistic ms timestamp, < MAX_SAFE_INTEGER
    db.query("INSERT INTO t (n) VALUES (?)").run(big);

    const row = db.query("SELECT n FROM t").get() as { n: number | bigint };
    expect(Number(row.n)).toBe(1_700_000_000_000);
    db.close();
  });
});

/**
 * WASM driver (node-sqlite3-wasm) file-locking behaviour.
 *
 * The driver locks the DB by creating an empty `<db>.lock` directory (an
 * atomic mkdir mutex) and removes it when SQLite drops to lock level NONE.
 * Two failure modes are guarded:
 *
 *  1. A `.get()` that reads one row leaves the statement cursor open, holding
 *     the lock past `close()` and leaking the dir → the `.get()` wrapper
 *     finalizes the statement so the driver releases the lock on close.
 *  2. A process killed mid-write leaks the dir → the next open consults the
 *     PID sentinel: a lock past a short safety floor whose owner is dead is
 *     cleared immediately, a lock whose owner is alive is kept, and a lock
 *     younger than the floor is always kept (so a stale sentinel can't steal a
 *     freshly-acquired live lock). With no sentinel it falls back to an age
 *     heuristic.
 */
describe("wasm driver lock handling", () => {
  let dir: string;

  /**
   * A PID that is almost certainly not a running process. `process.kill(pid, 0)`
   * throws ESRCH for it, so the adapter treats its lock as orphaned.
   */
  const DEAD_PID = findDeadPid();

  afterEach(() => {
    __setDriverForTests(null);
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a .get() does not leak a lock directory across close", () => {
    // Root-cause guard for the cross-invocation "database is locked" failure:
    // after a single-row read + close, no lock dir may survive.
    __setDriverForTests("wasm");
    dir = mkdtempSync(join(tmpdir(), "sqlite-get-"));
    const dbPath = join(dir, "cli.db");

    const db = new Database(dbPath);
    db.exec("CREATE TABLE t (a INTEGER)");
    db.query("INSERT INTO t (a) VALUES (?)").run(1);
    db.query("SELECT a FROM t").get();
    db.close();

    expect(existsSync(`${dbPath}.lock`)).toBe(false);
  });

  test("a second process can open after the first finishes", () => {
    // Simulates the CI smoke sequence (`--help` then `auth status`): two
    // sequential connections to the same DB must both succeed.
    __setDriverForTests("wasm");
    dir = mkdtempSync(join(tmpdir(), "sqlite-seq-"));
    const dbPath = join(dir, "cli.db");

    const first = new Database(dbPath);
    first.exec("CREATE TABLE t (a INTEGER)");
    first.query("INSERT INTO t (a) VALUES (?)").run(1);
    first.query("SELECT a FROM t").get();
    first.close();

    const second = new Database(dbPath);
    expect(second.query("SELECT a FROM t").get()).toEqual({ a: 1 });
    second.close();
  });

  test("clears a stale (old) leftover lock before opening", () => {
    // Simulates a lock leaked by a crashed process, backdated beyond the
    // staleness window so it's treated as orphaned and cleared.
    __setDriverForTests("wasm");
    dir = mkdtempSync(join(tmpdir(), "sqlite-stale-"));
    const dbPath = join(dir, "cli.db");

    const lockDir = `${dbPath}.lock`;
    mkdirSync(lockDir);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockDir, old, old);

    const db = new Database(dbPath);
    db.exec("CREATE TABLE t (a INTEGER)");
    db.query("INSERT INTO t (a) VALUES (?)").run(1);
    expect(db.query("SELECT a FROM t").get()).toEqual({ a: 1 });
    db.close();
  });

  test("does not clear a recent (possibly live) lock when opening", () => {
    // A freshly-created lock may belong to a concurrent process. The open-time
    // cleanup must leave it intact — deleting it could let two writers hold the
    // same DB at once (corruption). Live contention is left to busy_timeout.
    __setDriverForTests("wasm");
    dir = mkdtempSync(join(tmpdir(), "sqlite-live-"));
    const dbPath = join(dir, "cli.db");

    const lockDir = `${dbPath}.lock`;
    mkdirSync(lockDir);

    const db = new Database(dbPath);
    // The constructor's clearStaleWasmLock must not have removed the recent dir.
    expect(existsSync(lockDir)).toBe(true);
    db.close();
    // close() must not remove a foreign lock either (it's a shared mutex).
    expect(existsSync(lockDir)).toBe(true);
  });

  test("clears a dead-owner lock past the safety floor without the age wait", () => {
    // A process killed mid-write leaves the lock dir plus an owner sentinel.
    // Once the lock is older than the short safety floor, a dead owner PID
    // means it's provably orphaned — cleared without waiting the full 60s.
    __setDriverForTests("wasm");
    dir = mkdtempSync(join(tmpdir(), "sqlite-dead-"));
    const dbPath = join(dir, "cli.db");

    const lockDir = `${dbPath}.lock`;
    mkdirSync(lockDir);
    // Older than LOCK_SAFETY_FLOOR_MS (3s) but far younger than the 60s age
    // window — so only the dead-owner sentinel can justify clearing it.
    const pastFloor = new Date(Date.now() - 10_000);
    utimesSync(lockDir, pastFloor, pastFloor);
    writeFileSync(`${dbPath}.lock.owner`, String(DEAD_PID));

    const db = new Database(dbPath);
    db.exec("CREATE TABLE t (a INTEGER)");
    db.query("INSERT INTO t (a) VALUES (?)").run(1);
    expect(db.query("SELECT a FROM t").get()).toEqual({ a: 1 });
    db.close();
  });

  test("keeps a fresh lock even when the sentinel names a dead PID", () => {
    // Guards against a stale sentinel stealing a live lock: a lock younger than
    // the safety floor may have just been acquired by another (older) CLI that
    // doesn't refresh the sentinel, so a leftover dead-PID sentinel must NOT
    // cause it to be deleted.
    __setDriverForTests("wasm");
    dir = mkdtempSync(join(tmpdir(), "sqlite-fresh-dead-"));
    const dbPath = join(dir, "cli.db");

    const lockDir = `${dbPath}.lock`;
    mkdirSync(lockDir); // fresh mtime, under the safety floor
    writeFileSync(`${dbPath}.lock.owner`, String(DEAD_PID));

    const db = new Database(dbPath);
    // Under the floor: the fresh lock is preserved despite the dead sentinel.
    expect(existsSync(lockDir)).toBe(true);
    db.close();
  });

  test("keeps a lock owned by a live process, even if old", () => {
    // If the owner PID is still alive the lock is genuinely held; the age of
    // the directory is irrelevant and it must not be stolen.
    __setDriverForTests("wasm");
    dir = mkdtempSync(join(tmpdir(), "sqlite-alive-"));
    const dbPath = join(dir, "cli.db");

    const lockDir = `${dbPath}.lock`;
    mkdirSync(lockDir);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lockDir, old, old);
    // Our own PID is definitely alive.
    writeFileSync(`${dbPath}.lock.owner`, String(process.pid));

    const db = new Database(dbPath);
    expect(existsSync(lockDir)).toBe(true);
    db.close();
  });
});
