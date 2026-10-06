/**
 * Tests for span tree formatting
 */

import { describe, expect, test } from "vitest";
import { formatSimpleSpanTree } from "../../../src/lib/formatters/human.js";
import type { TraceSpan } from "../../../src/types/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip ANSI escape codes from a string for content assertions.
 * Allows tests to verify text content without color interference.
 */
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes use control chars
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Create a minimal TraceSpan for testing the simple span tree format.
 * TraceSpan differs from Span in that it has nested children (hierarchical structure).
 *
 * @param op - Operation name (e.g., "http.server", "db.query")
 * @param description - Human-readable description of the span
 * @param children - Nested child spans (already in tree form)
 * @param overrides - Optional field overrides for timestamps, duration, etc.
 */
function makeTraceSpan(
  op: string,
  description: string,
  children: TraceSpan[] = [],
  overrides?: Partial<TraceSpan>
): TraceSpan {
  return {
    span_id: `span-${op}`,
    op,
    description,
    start_timestamp: 1000.0,
    timestamp: 1001.0,
    children,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests for formatSimpleSpanTree
// ─────────────────────────────────────────────────────────────────────────────

describe("formatSimpleSpanTree", () => {
  describe("empty and edge cases", () => {
    test("returns empty array for empty spans array", () => {
      const result = formatSimpleSpanTree("trace-123", []);
      expect(result).toEqual([]);
    });

    test("includes trace ID in header", () => {
      const spans = [makeTraceSpan("http.server", "GET /api")];
      const result = formatSimpleSpanTree("abc123def456", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("Trace —");
      expect(output).toContain("abc123def456");
    });
  });

  describe("simple tree format", () => {
    test("shows op — description format", () => {
      const spans = [makeTraceSpan("http.server", "GET /api/users")];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("http.server");
      expect(output).toContain("—");
      expect(output).toContain("GET /api/users");
    });

    test("shows duration computed from timestamps", () => {
      // start=1000.0, timestamp=1001.0 -> 1000ms -> "1s"
      const spans = [makeTraceSpan("db.query", "SELECT * FROM users")];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("(1s)");
    });

    test("shows duration from API-provided duration field", () => {
      const spans = [
        makeTraceSpan("http.server", "GET /api", [], { duration: 245 }),
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("(245ms)");
    });

    test("prefers API duration over computed duration", () => {
      // API says 500ms, timestamps would give 1000ms - API wins
      const spans = [
        makeTraceSpan("http.server", "GET /api", [], {
          start_timestamp: 1000.0,
          timestamp: 1001.0,
          duration: 500,
        }),
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("(500ms)");
    });

    test("uses end_timestamp over timestamp for duration", () => {
      // end_timestamp=1000.250 -> 250ms
      const spans = [
        makeTraceSpan("db.query", "SELECT 1", [], {
          start_timestamp: 1000.0,
          timestamp: 1001.0,
          end_timestamp: 1000.25,
        }),
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("(250ms)");
    });

    test("omits duration when no timestamps available", () => {
      const spans: TraceSpan[] = [
        {
          span_id: "1",
          op: "db.query",
          description: "SELECT * FROM users",
          start_timestamp: 1000.0,
          // no timestamp, no end_timestamp, no duration
        },
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).not.toMatch(/\(\d+ms\)/);
      expect(output).not.toMatch(/\(\d+\.\d+s\)/);
    });

    test("handles missing op gracefully", () => {
      const spans: TraceSpan[] = [
        {
          span_id: "1",
          description: "Some operation",
          start_timestamp: 1000.0,
          timestamp: 1001.0,
        },
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("unknown");
      expect(output).toContain("Some operation");
    });

    test("handles missing description gracefully", () => {
      const spans: TraceSpan[] = [
        {
          span_id: "1",
          op: "http.client",
          start_timestamp: 1000.0,
          timestamp: 1001.0,
        },
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("http.client");
      expect(output).toContain("(no description)");
    });

    test("uses transaction as fallback for description", () => {
      const spans: TraceSpan[] = [
        {
          span_id: "1",
          op: "cli",
          transaction: "My CLI Command",
          start_timestamp: 1000.0,
          timestamp: 1001.0,
        },
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("My CLI Command");
    });
  });

  describe("nested children", () => {
    test("renders nested children with indentation", () => {
      const spans = [
        makeTraceSpan("cli", "Spotlight CLI", [
          makeTraceSpan("cli.setup", "Setup Spotlight", [
            makeTraceSpan("cli.setup.assets", "Setup Server Assets"),
          ]),
        ]),
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const lines = result.map(stripAnsi);

      // Check that all spans are present
      const output = lines.join("\n");
      expect(output).toContain("cli — Spotlight CLI");
      expect(output).toContain("cli.setup — Setup Spotlight");
      expect(output).toContain("cli.setup.assets — Setup Server Assets");

      // Check indentation increases for nested children
      const cliLine = lines.find((l) => l.includes("Spotlight CLI"));
      const setupLine = lines.find((l) => l.includes("Setup Spotlight"));
      const assetsLine = lines.find((l) => l.includes("Setup Server Assets"));

      expect(cliLine).toBeDefined();
      expect(setupLine).toBeDefined();
      expect(assetsLine).toBeDefined();

      // Nested lines should have more leading whitespace
      const cliIndent = cliLine?.match(/^\s*/)?.[0].length ?? 0;
      const setupIndent = setupLine?.match(/^\s*/)?.[0].length ?? 0;
      const assetsIndent = assetsLine?.match(/^\s*/)?.[0].length ?? 0;

      expect(setupIndent).toBeGreaterThan(cliIndent);
      expect(assetsIndent).toBeGreaterThan(setupIndent);
    });

    test("handles multiple root spans", () => {
      const spans = [
        makeTraceSpan("http.server", "POST /api"),
        makeTraceSpan("db.query", "SELECT *"),
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));

      expect(output).toContain("http.server — POST /api");
      expect(output).toContain("db.query — SELECT *");
    });

    test("shows durations on nested children", () => {
      const spans = [
        makeTraceSpan(
          "http.server",
          "GET /api",
          [
            makeTraceSpan("db.query", "SELECT *", [], {
              start_timestamp: 1000.0,
              timestamp: 1000.05,
            }),
          ],
          { start_timestamp: 1000.0, timestamp: 1000.5 }
        ),
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("GET /api");
      expect(output).toContain("(500ms)");
      expect(output).toContain("SELECT *");
      expect(output).toContain("(50ms)");
    });

    test("handles deeply nested spans (3+ levels)", () => {
      const spans = [
        makeTraceSpan("level1", "First", [
          makeTraceSpan("level2", "Second", [
            makeTraceSpan("level3", "Third", [
              makeTraceSpan("level4", "Fourth"),
            ]),
          ]),
        ]),
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));

      expect(output).toContain("level1 — First");
      expect(output).toContain("level2 — Second");
      expect(output).toContain("level3 — Third");
      expect(output).toContain("level4 — Fourth");
    });
  });

  describe("depth limiting", () => {
    test("respects maxDepth parameter", () => {
      const spans = [
        makeTraceSpan("level1", "First", [
          makeTraceSpan("level2", "Second", [makeTraceSpan("level3", "Third")]),
        ]),
      ];
      const result = formatSimpleSpanTree("trace-123", spans, 2);
      const output = stripAnsi(result.join("\n"));

      // Should show level 1 and 2, but not level 3
      expect(output).toContain("level1 — First");
      expect(output).toContain("level2 — Second");
      expect(output).not.toContain("level3 — Third");
    });

    test("maxDepth 0 returns empty (disabled)", () => {
      const spans = [
        makeTraceSpan("level1", "First", [
          makeTraceSpan("level2", "Second", [makeTraceSpan("level3", "Third")]),
        ]),
      ];
      const result = formatSimpleSpanTree("trace-123", spans, 0);
      expect(result).toEqual([]);
    });

    test("maxDepth Infinity shows all levels", () => {
      const spans = [
        makeTraceSpan("level1", "First", [
          makeTraceSpan("level2", "Second", [makeTraceSpan("level3", "Third")]),
        ]),
      ];
      const result = formatSimpleSpanTree(
        "trace-123",
        spans,
        Number.POSITIVE_INFINITY
      );
      const output = stripAnsi(result.join("\n"));

      expect(output).toContain("level1 — First");
      expect(output).toContain("level2 — Second");
      expect(output).toContain("level3 — Third");
    });
  });

  describe("tree branch characters", () => {
    test("uses tree branch characters", () => {
      const spans = [
        makeTraceSpan("root", "Root Span", [
          makeTraceSpan("child1", "First Child"),
          makeTraceSpan("child2", "Second Child"),
        ]),
      ];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = result.join("\n");

      // Should use tree branch characters
      expect(output).toContain("└─");
      expect(output).toContain("├─");
    });
  });

  describe("section header", () => {
    test("includes Span Tree section divider", () => {
      const spans = [makeTraceSpan("http.server", "GET /api")];
      const result = formatSimpleSpanTree("trace-123", spans);
      const output = stripAnsi(result.join("\n"));
      expect(output).toContain("─── Span Tree ───");
    });
  });
});
