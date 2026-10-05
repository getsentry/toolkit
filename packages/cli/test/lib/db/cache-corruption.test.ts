/**
 * Corruption-resilience tests for the SQLite cache readers.
 *
 * Cached JSON columns can be corrupted by partial writes, manual edits, or
 * schema drift. These tests assert that the readers treat such corruption as a
 * cache miss (returning undefined and clearing the bad row where applicable)
 * instead of throwing a SyntaxError that would crash the command.
 */

import { describe, expect, test } from "vitest";
import { getDatabase } from "../../../src/lib/db/index.js";
import { getPaginationState } from "../../../src/lib/db/pagination.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("cache-corruption-");

const CMD_KEY = "corrupt-list";
const CTX_KEY = "org:test|sort:date";

/** Insert a raw pagination row with the given (possibly invalid) cursor_stack. */
function insertPaginationRow(cursorStack: string): void {
  const db = getDatabase();
  db.query(
    `INSERT OR REPLACE INTO pagination_cursors
       (command_key, context, cursor_stack, page_index, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(CMD_KEY, CTX_KEY, cursorStack, 0, Date.now() + 60_000);
}

function paginationRowCount(): number {
  const db = getDatabase();
  const row = db
    .query(
      "SELECT COUNT(*) AS n FROM pagination_cursors WHERE command_key = ? AND context = ?"
    )
    .get(CMD_KEY, CTX_KEY) as { n: number };
  return row.n;
}

describe("getPaginationState corruption handling", () => {
  test("returns undefined and deletes the row on unparseable JSON", () => {
    insertPaginationRow("{not valid json");
    expect(paginationRowCount()).toBe(1);

    expect(getPaginationState(CMD_KEY, CTX_KEY)).toBeUndefined();
    expect(paginationRowCount()).toBe(0);
  });

  test("returns undefined and deletes the row when JSON is not an array", () => {
    insertPaginationRow(JSON.stringify({ not: "an array" }));
    expect(paginationRowCount()).toBe(1);

    expect(getPaginationState(CMD_KEY, CTX_KEY)).toBeUndefined();
    expect(paginationRowCount()).toBe(0);
  });

  test("returns the parsed stack for valid array JSON", () => {
    insertPaginationRow(JSON.stringify(["", "cursor-1"]));

    const state = getPaginationState(CMD_KEY, CTX_KEY);
    expect(state?.stack).toEqual(["", "cursor-1"]);
    expect(state?.index).toBe(0);
  });
});
