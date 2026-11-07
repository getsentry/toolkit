/**
 * A database that stores nothing, for invocations with persistence off.
 *
 * Reads miss (`get()` returns `null`, `all()` returns `[]`) and writes do
 * nothing. It skips schema setup and migrations, which read rows they expect
 * to exist, so callers must not depend on any table being present.
 *
 * @module
 */

import type { DatabaseHandle } from "./sqlite.js";

const nullStatement: ReturnType<DatabaseHandle["query"]> = {
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
