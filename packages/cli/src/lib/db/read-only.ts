/**
 * Database handles for invocations with persistence off: they read what the
 * CLI already stored but never write.
 *
 * {@link readOnlyView} wraps the shared connection and passes only `SELECT`
 * statements through. Everything else is dropped, including the
 * `DELETE ... RETURNING` drains that read through `get()`/`all()`.
 *
 * {@link nullDatabase} stands in when there's no `cli.db` to read or it won't
 * open. Reads miss (`get()` returns `null`, `all()` returns `[]`) and writes
 * do nothing. It skips schema setup and migrations, which read rows they
 * expect to exist, so callers must not depend on any table being present.
 *
 * @module
 */

import type { DatabaseHandle } from "./sqlite.js";

type Statement = ReturnType<DatabaseHandle["query"]>;

const nullStatement: Statement = {
  get: () => null,
  all: () => [],
  run: () => {
    // Writes are dropped.
  },
};

/** The shared null store. It holds no state, so one instance serves every call. */
export const nullDatabase: DatabaseHandle = {
  exec: () => {
    // Statements are dropped.
  },
  query: () => nullStatement,
  transaction:
    <T>(fn: () => T) =>
    () =>
      fn(),
  close: () => {
    // Nothing to close.
  },
};

const READ_STATEMENT = /^\s*SELECT\b/i;

/**
 * A view of `db` that reads but never writes. `close()` does nothing: the
 * connection is shared with invocations that persist.
 */
export function readOnlyView(db: DatabaseHandle): DatabaseHandle {
  return {
    ...nullDatabase,
    query: (sql) => (READ_STATEMENT.test(sql) ? db.query(sql) : nullStatement),
  };
}
