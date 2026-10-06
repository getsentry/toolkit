/**
 * Property-Based Tests for SQL Syntax Highlighting
 *
 * Verifies invariants that should hold for any valid SQL-ish input:
 * - ANSI stripping preserves original text content
 * - Plain mode returns input unchanged
 * - Colorization is deterministic
 */

import chalk from "chalk";
import {
  array,
  constantFrom,
  assert as fcAssert,
  oneof,
  property,
  stringMatching,
} from "fast-check";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { stripAnsi } from "../../../src/lib/formatters/plain-detect.js";
import { colorizeSql, isDbSpanOp } from "../../../src/lib/formatters/sql.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

// Force chalk to emit ANSI codes even when stdout is not a TTY (test runner)
chalk.level = 3;

let originalPlainOutput: string | undefined;
let originalNoColor: string | undefined;

beforeEach(() => {
  originalPlainOutput = process.env.SENTRY_PLAIN_OUTPUT;
  originalNoColor = process.env.NO_COLOR;
});

afterEach(() => {
  if (originalPlainOutput !== undefined) {
    process.env.SENTRY_PLAIN_OUTPUT = originalPlainOutput;
  } else {
    delete process.env.SENTRY_PLAIN_OUTPUT;
  }
  if (originalNoColor !== undefined) {
    process.env.NO_COLOR = originalNoColor;
  } else {
    delete process.env.NO_COLOR;
  }
});

/** SQL keywords that @sentry/sqlish recognizes */
const sqlKeywordArb = constantFrom(
  "SELECT",
  "FROM",
  "WHERE",
  "INSERT",
  "INTO",
  "UPDATE",
  "DELETE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "ORDER",
  "BY",
  "GROUP",
  "LIMIT",
  "OFFSET",
  "VALUES",
  "SET",
  "AND",
  "OR",
  "IN",
  "NOT",
  "NULL",
  "AS",
  "ON",
  "RETURNING"
);

/** Table/column identifiers */
const identifierArb = stringMatching(/^[a-z_][a-z0-9_]{0,15}$/);

/** Parameter placeholders */
const parameterArb = constantFrom("%s", "$1", "$2", "$3", "?", "%d");

/** Build random SQL-ish strings from tokens */
const sqlTokenArb = oneof(sqlKeywordArb, identifierArb, parameterArb);

const sqlStringArb = array(sqlTokenArb, { minLength: 1, maxLength: 12 }).map(
  (tokens) => tokens.join(" ")
);

/** Span op values */
const dbOpArb = constantFrom(
  "db",
  "db.query",
  "db.sql.query",
  "db.sql.execute",
  "db.redis",
  "db.mongodb"
);
const nonDbOpArb = constantFrom(
  "http.client",
  "http.server",
  "cache.get",
  "browser",
  "queue.process"
);

describe("property: isDbSpanOp", () => {
  test("always true for db.* ops", () => {
    fcAssert(
      property(dbOpArb, (op) => {
        expect(isDbSpanOp(op)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("always false for non-db ops", () => {
    fcAssert(
      property(nonDbOpArb, (op) => {
        expect(isDbSpanOp(op)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: colorizeSql", () => {
  test("stripping ANSI preserves original text content (case-insensitive)", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    fcAssert(
      property(sqlStringArb, (sql) => {
        const colorized = colorizeSql(sql);
        const stripped = stripAnsi(colorized);
        // Case-insensitive: @sentry/sqlish uppercases SQL keywords (e.g. "by" → "BY")
        expect(stripped.toLowerCase()).toBe(sql.toLowerCase());
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("plain mode returns input unchanged (identity)", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "1";
    fcAssert(
      property(sqlStringArb, (sql) => {
        expect(colorizeSql(sql)).toBe(sql);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is deterministic: same input always gives same output", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    fcAssert(
      property(sqlStringArb, (sql) => {
        expect(colorizeSql(sql)).toBe(colorizeSql(sql));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent strip: stripAnsi(colorizeSql(x)) == stripAnsi(colorizeSql(stripAnsi(colorizeSql(x))))", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    fcAssert(
      property(sqlStringArb, (sql) => {
        const once = stripAnsi(colorizeSql(sql));
        const twice = stripAnsi(colorizeSql(stripAnsi(colorizeSql(sql))));
        expect(once).toBe(twice);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("never returns empty for non-empty input", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    fcAssert(
      property(sqlStringArb, (sql) => {
        if (sql.length > 0) {
          expect(colorizeSql(sql).length).toBeGreaterThan(0);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
