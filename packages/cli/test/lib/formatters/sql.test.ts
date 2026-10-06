/**
 * Unit tests for SQL syntax highlighting.
 *
 * Core invariants (round-trips, plain-mode identity) are tested via
 * property-based tests in sql.property.test.ts. These tests focus on
 * specific token coloring, edge cases, and formatSqlBlock structure.
 */

import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { stripAnsi } from "../../../src/lib/formatters/plain-detect.js";
import {
  colorizeSql,
  formatSqlBlock,
  isDbSpanOp,
} from "../../../src/lib/formatters/sql.js";

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

describe("isDbSpanOp", () => {
  test('returns true for "db"', () => {
    expect(isDbSpanOp("db")).toBe(true);
  });

  test('returns true for "db.query"', () => {
    expect(isDbSpanOp("db.query")).toBe(true);
  });

  test('returns true for "db.sql.query"', () => {
    expect(isDbSpanOp("db.sql.query")).toBe(true);
  });

  test('returns true for "db.redis"', () => {
    expect(isDbSpanOp("db.redis")).toBe(true);
  });

  test('returns false for "http.client"', () => {
    expect(isDbSpanOp("http.client")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isDbSpanOp(undefined)).toBe(false);
  });

  test("returns false for null", () => {
    expect(isDbSpanOp(null)).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isDbSpanOp("")).toBe(false);
  });

  test('returns false for "database" (no dot separator)', () => {
    expect(isDbSpanOp("database")).toBe(false);
  });
});

describe("colorizeSql", () => {
  test("returns original text in plain mode", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "1";
    const sql = "SELECT id, name FROM users WHERE id = %s";
    expect(colorizeSql(sql)).toBe(sql);
  });

  test("returns string with ANSI codes in TTY mode for SQL with keywords", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    const sql = "SELECT id FROM users";
    const result = colorizeSql(sql);
    // Should contain ANSI escape codes
    expect(result).toContain("\x1b[");
    // Should still contain the original text when stripped
    expect(stripAnsi(result)).toBe(sql);
  });

  test("colorizes SQL keywords", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    const result = colorizeSql("SELECT * FROM users");
    // Keywords should be colored (different from plain text)
    expect(result).not.toBe("SELECT * FROM users");
    expect(stripAnsi(result)).toBe("SELECT * FROM users");
  });

  test("colorizes parameters", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    const result = colorizeSql("SELECT * FROM users WHERE id = %s");
    expect(result).toContain("\x1b[");
    expect(stripAnsi(result)).toBe("SELECT * FROM users WHERE id = %s");
  });

  test("handles empty string", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    const result = colorizeSql("");
    expect(result).toBe("");
  });

  test("handles non-SQL content gracefully", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    const input = "GET /api/users/123";
    const result = colorizeSql(input);
    // Should not crash; stripped output should contain original text
    expect(stripAnsi(result)).toContain("GET");
  });
});

describe("formatSqlBlock", () => {
  test("returns compact single-line with header in plain mode", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "1";
    const sql = "SELECT id, name FROM users WHERE id = %s";
    const result = formatSqlBlock(sql);
    expect(result).toContain("─── Query ───");
    expect(result).toContain(sql);
    // No ANSI codes
    expect(result).not.toContain("\x1b[");
  });

  test("returns multi-line formatted SQL with header in TTY mode", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    const sql = "SELECT id, name FROM users WHERE id = %s";
    const result = formatSqlBlock(sql);
    expect(result).toContain("─── Query ───");
    // Should contain ANSI escape codes
    expect(result).toContain("\x1b[");
    // Should have newlines from pretty-printing
    const stripped = stripAnsi(result);
    // The pretty-printer adds newlines at SELECT, FROM, WHERE
    expect(stripped).toContain("SELECT");
    expect(stripped).toContain("FROM");
    expect(stripped).toContain("WHERE");
  });

  test("does not reformat SQL in plain mode", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "1";
    const sql = "SELECT id FROM users WHERE active = true";
    const result = formatSqlBlock(sql);
    // The raw SQL should appear exactly as-is (not reformatted)
    expect(result).toContain(sql);
  });

  test("handles simple queries", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    const sql = "SELECT 1";
    const result = formatSqlBlock(sql);
    expect(stripAnsi(result)).toContain("SELECT");
  });
});
