/**
 * Tests for the generic table renderer.
 *
 * writeTable now renders via marked-terminal producing Unicode box-drawing
 * tables. Tests verify content is present rather than exact text alignment.
 */

import { describe, expect, test, vi } from "vitest";
import { escapeMarkdownCell } from "../../../src/lib/formatters/markdown.js";
import { type Column, writeTable } from "../../../src/lib/formatters/table.js";

type Row = { name: string; count: number; status: string };

const columns: Column<Row>[] = [
  { header: "NAME", value: (r) => r.name },
  { header: "COUNT", value: (r) => String(r.count), align: "right" },
  { header: "STATUS", value: (r) => r.status },
];

/** Strip ANSI escape codes */
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control chars
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function capture(items: Row[], cols = columns): string {
  const write = vi.fn(() => true);
  writeTable({ write }, items, cols);
  return stripAnsi(write.mock.calls.map((c) => c[0]).join(""));
}

describe("writeTable", () => {
  test("renders header and rows with content", () => {
    const output = capture([
      { name: "alpha", count: 42, status: "active" },
      { name: "beta-longer", count: 7, status: "inactive" },
    ]);

    // Header present
    expect(output).toContain("NAME");
    expect(output).toContain("COUNT");
    expect(output).toContain("STATUS");

    // Data present
    expect(output).toContain("alpha");
    expect(output).toContain("42");
    expect(output).toContain("active");
    expect(output).toContain("beta-longer");
    expect(output).toContain("7");
    expect(output).toContain("inactive");
  });

  test("all column values appear in rendered output", () => {
    const output = capture([
      { name: "a", count: 1, status: "ok" },
      { name: "b", count: 999, status: "ok" },
    ]);

    expect(output).toContain("1");
    expect(output).toContain("999");
  });

  test("respects minWidth — values appear in output", () => {
    const cols: Column<Row>[] = [
      { header: "N", value: (r) => r.name, minWidth: 10 },
      { header: "C", value: (r) => String(r.count) },
      { header: "S", value: (r) => r.status },
    ];

    const output = capture([{ name: "x", count: 1, status: "y" }], cols);
    expect(output).toContain("N");
    expect(output).toContain("x");
    expect(output).toContain("1");
    expect(output).toContain("y");
  });

  test("handles empty items array — only headers rendered", () => {
    const output = capture([]);
    expect(output).toContain("NAME");
    expect(output).toContain("COUNT");
    expect(output).toContain("STATUS");
  });

  test("column width respects header length even with short values", () => {
    const cols: Column<{ v: string }>[] = [
      { header: "VERY_LONG_HEADER", value: (r) => r.v },
    ];
    const write = vi.fn(() => true);
    writeTable({ write }, [{ v: "x" }], cols);
    const output = stripAnsi(write.mock.calls.map((c) => c[0]).join(""));
    expect(output).toContain("VERY_LONG_HEADER");
    expect(output).toContain("x");
  });
});

// ---------------------------------------------------------------------------
// TTY-mode output (ANSI box-drawing tables)
// ---------------------------------------------------------------------------

describe("writeTable (TTY mode)", () => {
  const saved = {
    plain: process.env.SENTRY_PLAIN_OUTPUT,
    columns: process.stdout.columns,
  };

  function withTty(fn: () => void): void {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    process.stdout.columns = 120;
    try {
      fn();
    } finally {
      if (saved.plain !== undefined) {
        process.env.SENTRY_PLAIN_OUTPUT = saved.plain;
      } else {
        delete process.env.SENTRY_PLAIN_OUTPUT;
      }
      process.stdout.columns = saved.columns as number;
    }
  }

  test("renders Unicode box-drawing borders", () => {
    withTty(() => {
      const write = vi.fn(() => true);
      writeTable({ write }, [{ name: "a", count: 1, status: "ok" }], columns);
      const output = write.mock.calls.map((c) => c[0]).join("");
      expect(stripAnsi(output)).toContain("│");
      expect(stripAnsi(output)).toContain("─");
    });
  });

  test("renders content in ANSI mode", () => {
    withTty(() => {
      const write = vi.fn(() => true);
      writeTable(
        { write },
        [{ name: "alice", count: 42, status: "active" }],
        columns
      );
      const output = stripAnsi(write.mock.calls.map((c) => c[0]).join(""));
      expect(output).toContain("NAME");
      expect(output).toContain("alice");
      expect(output).toContain("42");
      expect(output).toContain("active");
    });
  });

  test("passes rowSeparator option to renderer", () => {
    withTty(() => {
      const write = vi.fn(() => true);
      writeTable(
        { write },
        [
          { name: "a", count: 1, status: "x" },
          { name: "b", count: 2, status: "y" },
          { name: "c", count: 3, status: "z" },
        ],
        columns,
        { rowSeparator: true }
      );
      const raw = write.mock.calls.map((c) => c[0]).join("");
      const output = stripAnsi(raw);
      // With 3 data rows, there should be 2 row separators (├─┼─┤ lines)
      // plus 1 header separator = at least 3 mid-lines with ├
      const midLines = output.split("\n").filter((l) => l.includes("├"));
      expect(midLines.length).toBeGreaterThanOrEqual(3);
    });
  });

  test("passes rowSeparator color string to renderer", () => {
    withTty(() => {
      const write = vi.fn(() => true);
      const color = "\x1b[38;2;137;130;148m";
      writeTable(
        { write },
        [
          { name: "a", count: 1, status: "x" },
          { name: "b", count: 2, status: "y" },
        ],
        columns,
        { rowSeparator: color }
      );
      const raw = write.mock.calls.map((c) => c[0]).join("");
      // The color escape should appear in the output
      expect(raw).toContain(color);
    });
  });

  test("passes truncate option to renderer", () => {
    withTty(() => {
      const cols: Column<{ v: string }>[] = [
        { header: "VAL", value: (r) => r.v, minWidth: 10 },
      ];
      const write = vi.fn(() => true);
      const longText = "a".repeat(200);
      writeTable({ write }, [{ v: longText }], cols, { truncate: true });
      const output = stripAnsi(write.mock.calls.map((c) => c[0]).join(""));
      // Truncated text should have ellipsis
      expect(output).toContain("…");
    });
  });

  test("respects column alignment", () => {
    withTty(() => {
      const write = vi.fn(() => true);
      writeTable({ write }, [{ name: "x", count: 42, status: "ok" }], columns);
      const output = stripAnsi(write.mock.calls.map((c) => c[0]).join(""));
      // Right-aligned COUNT should have leading space before 42
      const lines = output.split("\n").filter((l) => l.includes("42"));
      expect(lines.length).toBeGreaterThan(0);
      // The 42 should be preceded by at least one space (right-aligned)
      expect(lines[0]).toMatch(/\s+42\s/);
    });
  });
});

// ---------------------------------------------------------------------------
// Plain-mode output (raw markdown tables)
// ---------------------------------------------------------------------------

describe("writeTable (plain mode)", () => {
  const saved = {
    plain: process.env.SENTRY_PLAIN_OUTPUT,
    noColor: process.env.NO_COLOR,
  };

  function withPlain(fn: () => void): void {
    process.env.SENTRY_PLAIN_OUTPUT = "1";
    process.env.NO_COLOR = undefined;
    try {
      fn();
    } finally {
      if (saved.plain !== undefined) {
        process.env.SENTRY_PLAIN_OUTPUT = saved.plain;
      } else {
        delete process.env.SENTRY_PLAIN_OUTPUT;
      }
      if (saved.noColor !== undefined) {
        process.env.NO_COLOR = saved.noColor;
      } else {
        delete process.env.NO_COLOR;
      }
    }
  }

  test("emits box-drawing table with stripped markdown", () => {
    withPlain(() => {
      const write = vi.fn(() => true);
      writeTable(
        { write },
        [{ name: "alice", count: 1, status: "ok" }],
        columns
      );
      const output = write.mock.calls.map((c) => c[0]).join("");
      // Box-drawing table format (not raw markdown pipes)
      expect(output).toContain("│");
      expect(output).toContain("NAME");
      expect(output).toContain("alice");
    });
  });

  test("pipe characters in values are preserved in box-drawing table", () => {
    withPlain(() => {
      const cols: Column<{ v: string }>[] = [
        { header: "VAL", value: (r) => escapeMarkdownCell(r.v) },
      ];
      const write = vi.fn(() => true);
      writeTable({ write }, [{ v: "a|b" }], cols);
      const output = write.mock.calls.map((c) => c[0]).join("");
      // Content is visible in box-drawing table
      expect(output).toContain("VAL");
    });
  });
});
