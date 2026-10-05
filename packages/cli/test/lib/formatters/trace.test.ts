/**
 * Unit Tests for Trace Formatters
 *
 * Tests for formatTraceDuration, formatTraceTable, formatTracesHeader, formatTraceRow,
 * computeTraceSummary, formatTraceSummary, and translateSpanQuery.
 *
 * Note: Core invariants (duration formatting, trace ID containment, row newline
 * termination, determinism, span counting) are tested via property-based tests
 * in trace.property.test.ts. These tests focus on specific format output values,
 * rendered vs plain mode behavior, header newline termination, and edge cases.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeSpanDurationMs } from "../../../src/lib/formatters/time-utils.js";
import {
  computeTraceSummary,
  findSpanById,
  formatTraceDuration,
  formatTraceRow,
  formatTraceSummary,
  formatTracesHeader,
  formatTraceTable,
  spanListItemToFlatSpan,
  translateSpanQuery,
} from "../../../src/lib/formatters/trace.js";
import type {
  SpanListItem,
  TraceSpan,
  TransactionListItem,
} from "../../../src/types/index.js";

/**
 * Strip ANSI escape codes for content assertions.
 */
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI codes use control chars
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Force rendered (TTY) mode for a describe block */
function useRenderedMode() {
  let savedPlain: string | undefined;
  beforeEach(() => {
    savedPlain = process.env.SENTRY_PLAIN_OUTPUT;
    process.env.SENTRY_PLAIN_OUTPUT = "0";
  });
  afterEach(() => {
    if (savedPlain === undefined) {
      delete process.env.SENTRY_PLAIN_OUTPUT;
    } else {
      process.env.SENTRY_PLAIN_OUTPUT = savedPlain;
    }
  });
}

/** Force plain mode for a describe block */
function usePlainMode() {
  let savedPlain: string | undefined;
  beforeEach(() => {
    savedPlain = process.env.SENTRY_PLAIN_OUTPUT;
    process.env.SENTRY_PLAIN_OUTPUT = "1";
  });
  afterEach(() => {
    if (savedPlain === undefined) {
      delete process.env.SENTRY_PLAIN_OUTPUT;
    } else {
      process.env.SENTRY_PLAIN_OUTPUT = savedPlain;
    }
  });
}

/**
 * Create a minimal TraceSpan for testing.
 */
function makeSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    span_id: "abc123",
    start_timestamp: 1_700_000_000.0,
    timestamp: 1_700_000_001.5,
    ...overrides,
  };
}

/**
 * Create a minimal TransactionListItem for testing.
 */
function makeTransaction(
  overrides: Partial<TransactionListItem> = {}
): TransactionListItem {
  return {
    trace: "a".repeat(32),
    id: "b".repeat(32),
    transaction: "GET /api/users",
    timestamp: "2025-01-15T10:30:00Z",
    "span.duration": 1234,
    project: "my-project",
    ...overrides,
  };
}

describe("formatTraceDuration", () => {
  test("formats sub-second durations in milliseconds", () => {
    expect(formatTraceDuration(0)).toBe("0ms");
    expect(formatTraceDuration(1)).toBe("1ms");
    expect(formatTraceDuration(245)).toBe("245ms");
    expect(formatTraceDuration(999)).toBe("999ms");
  });

  test("formats seconds with two decimal places", () => {
    expect(formatTraceDuration(1000)).toBe("1.00s");
    expect(formatTraceDuration(1240)).toBe("1.24s");
    expect(formatTraceDuration(59_995)).toBe("59.99s");
  });

  test("formats minutes and seconds for >= 60s", () => {
    expect(formatTraceDuration(60_000)).toBe("1m 0s");
    expect(formatTraceDuration(135_000)).toBe("2m 15s");
    expect(formatTraceDuration(3_600_000)).toBe("60m 0s");
  });

  test("handles seconds rollover (never produces '60s')", () => {
    expect(formatTraceDuration(119_500)).toBe("2m 0s");
    expect(formatTraceDuration(179_500)).toBe("3m 0s");
    expect(formatTraceDuration(59_500)).toBe("59.50s");
  });

  test("returns dash for invalid values", () => {
    expect(formatTraceDuration(Number.NaN)).toBe("—");
    expect(formatTraceDuration(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatTraceDuration(Number.NEGATIVE_INFINITY)).toBe("—");
    expect(formatTraceDuration(-100)).toBe("—");
  });
});

describe("formatTracesHeader (rendered mode)", () => {
  useRenderedMode();

  test("contains column titles", () => {
    const header = stripAnsi(formatTracesHeader());
    expect(header).toContain("Trace ID");
    expect(header).toContain("Transaction");
    expect(header).toContain("Duration");
    expect(header).toContain("When");
  });

  test("ends with newline", () => {
    // Property test only checks Row newlines, not Header
    expect(formatTracesHeader().endsWith("\n")).toBe(true);
  });
});

describe("formatTraceRow (rendered mode)", () => {
  useRenderedMode();

  test("includes transaction name", () => {
    const row = formatTraceRow(
      makeTransaction({ transaction: "POST /api/data" })
    );
    expect(row).toContain("POST /api/data");
  });

  test("includes formatted duration", () => {
    const row = formatTraceRow(makeTransaction({ "span.duration": 245 }));
    expect(row).toContain("245ms");
  });

  test("includes full transaction name in markdown row", () => {
    const longName = "A".repeat(50);
    const row = formatTraceRow(makeTransaction({ transaction: longName }));
    expect(row).toContain(longName);
  });

  test("shows 'unknown' for empty transaction", () => {
    const row = formatTraceRow(makeTransaction({ transaction: "" }));
    expect(row).toContain("unknown");
  });
});

describe("formatTracesHeader (plain mode)", () => {
  usePlainMode();

  test("emits markdown table header and separator", () => {
    const result = formatTracesHeader();
    expect(result).toContain("| Trace ID | Transaction | Duration | When |");
    expect(result).toContain("| --- | --- | ---: | --- |");
  });

  test("ends with newline", () => {
    expect(formatTracesHeader()).toEndWith("\n");
  });
});

describe("formatTraceRow (plain mode)", () => {
  usePlainMode();

  test("emits a markdown table row", () => {
    const row = formatTraceRow(makeTransaction());
    expect(row).toMatch(/^\|.+\|.+\|.+\|.+\|\n$/);
  });

  test("includes transaction name", () => {
    const row = formatTraceRow(
      makeTransaction({ transaction: "POST /api/data" })
    );
    expect(row).toContain("POST /api/data");
  });

  test("includes formatted duration", () => {
    const row = formatTraceRow(makeTransaction({ "span.duration": 245 }));
    expect(row).toContain("245ms");
  });

  test("does not truncate long transaction names (no column padding in plain mode)", () => {
    const longName = "A".repeat(50);
    const row = formatTraceRow(makeTransaction({ transaction: longName }));
    expect(row).toContain(longName);
  });

  test("escapes pipe characters in transaction name", () => {
    const row = formatTraceRow(makeTransaction({ transaction: "GET /a|b" }));
    // Pipe replaced with box-drawing │ so it doesn't break the table
    expect(row).toContain("GET /a\u2502b");
  });

  test("shows 'unknown' for empty transaction", () => {
    const row = formatTraceRow(makeTransaction({ transaction: "" }));
    expect(row).toContain("unknown");
  });
});

describe("computeTraceSummary", () => {
  test("computes duration from span timestamps", () => {
    const spans: TraceSpan[] = [
      makeSpan({ start_timestamp: 1000.0, timestamp: 1002.5 }),
    ];
    const summary = computeTraceSummary("trace-id", spans);
    expect(summary.duration).toBe(2500);
  });

  test("finds min start and max end across multiple spans", () => {
    const spans: TraceSpan[] = [
      makeSpan({ start_timestamp: 1000.0, timestamp: 1001.0 }),
      makeSpan({ start_timestamp: 999.5, timestamp: 1003.0 }),
    ];
    const summary = computeTraceSummary("trace-id", spans);
    expect(summary.duration).toBe(3500);
  });

  test("counts all spans including nested children", () => {
    const spans: TraceSpan[] = [
      makeSpan({
        children: [makeSpan({ children: [makeSpan()] }), makeSpan()],
      }),
    ];
    const summary = computeTraceSummary("trace-id", spans);
    expect(summary.spanCount).toBe(4);
  });

  test("collects unique project slugs", () => {
    const spans: TraceSpan[] = [
      makeSpan({
        project_slug: "frontend",
        children: [makeSpan({ project_slug: "backend" })],
      }),
      makeSpan({ project_slug: "frontend" }),
    ];
    const summary = computeTraceSummary("trace-id", spans);
    expect(summary.projects.sort()).toEqual(["backend", "frontend"]);
  });

  test("extracts root transaction name and op", () => {
    const spans: TraceSpan[] = [
      makeSpan({
        transaction: "GET /api/users",
        "transaction.op": "http.server",
      }),
    ];
    const summary = computeTraceSummary("trace-id", spans);
    expect(summary.rootTransaction).toBe("GET /api/users");
    expect(summary.rootOp).toBe("http.server");
  });

  test("uses description as fallback for root transaction", () => {
    const spans: TraceSpan[] = [makeSpan({ description: "My Transaction" })];
    const summary = computeTraceSummary("trace-id", spans);
    expect(summary.rootTransaction).toBe("My Transaction");
  });

  test("handles zero timestamps gracefully (NaN duration)", () => {
    const spans: TraceSpan[] = [makeSpan({ start_timestamp: 0, timestamp: 0 })];
    const summary = computeTraceSummary("trace-id", spans);
    expect(Number.isNaN(summary.duration)).toBe(true);
  });

  test("returns NaN duration for empty spans array", () => {
    // Property generator uses minLength:1, so empty array is never tested there
    const summary = computeTraceSummary("trace-id", []);
    expect(Number.isNaN(summary.duration)).toBe(true);
    expect(summary.spanCount).toBe(0);
  });

  test("ignores zero timestamps in min/max calculations", () => {
    const spans: TraceSpan[] = [
      makeSpan({ start_timestamp: 0, timestamp: 0 }),
      makeSpan({ start_timestamp: 1000.0, timestamp: 1002.0 }),
    ];
    const summary = computeTraceSummary("trace-id", spans);
    expect(summary.duration).toBe(2000);
  });

  test("falls back to timestamp when end_timestamp is 0", () => {
    const spans: TraceSpan[] = [
      makeSpan({
        start_timestamp: 1000.0,
        end_timestamp: 0,
        timestamp: 1002.5,
      }),
    ];
    const summary = computeTraceSummary("trace-id", spans);
    expect(summary.duration).toBe(2500);
  });
});

describe("formatTraceSummary", () => {
  test("includes trace ID in header", () => {
    const summary = computeTraceSummary("abc123def456", [
      makeSpan({ start_timestamp: 1000.0, timestamp: 1001.0 }),
    ]);
    const output = stripAnsi(formatTraceSummary(summary));
    expect(output).toContain("abc123def456");
  });

  test("shows root transaction with op prefix", () => {
    const summary = computeTraceSummary("trace-id", [
      makeSpan({
        transaction: "GET /api/users",
        "transaction.op": "http.server",
      }),
    ]);
    const output = stripAnsi(formatTraceSummary(summary));
    expect(output).toContain("http.server");
    expect(output).toContain("GET /api/users");
  });

  test("shows duration", () => {
    const summary = computeTraceSummary("trace-id", [
      makeSpan({ start_timestamp: 1000.0, timestamp: 1001.24 }),
    ]);
    const output = stripAnsi(formatTraceSummary(summary));
    expect(output).toContain("Duration");
    expect(output).toContain("1.24s");
  });

  test("shows dash for NaN duration", () => {
    const summary = computeTraceSummary("trace-id", [
      makeSpan({ start_timestamp: 0, timestamp: 0 }),
    ]);
    const output = stripAnsi(formatTraceSummary(summary));
    expect(output).toContain("Duration");
    expect(output).toContain("—");
  });

  test("shows span count", () => {
    const summary = computeTraceSummary("trace-id", [
      makeSpan({ children: [makeSpan(), makeSpan()] }),
    ]);
    const output = stripAnsi(formatTraceSummary(summary));
    expect(output).toContain("Spans");
    expect(output).toContain("3");
  });

  test("shows projects when present", () => {
    const summary = computeTraceSummary("trace-id", [
      makeSpan({ project_slug: "my-app" }),
    ]);
    const output = stripAnsi(formatTraceSummary(summary));
    expect(output).toContain("Projects");
    expect(output).toContain("my-app");
  });

  test("shows start time for valid timestamps", () => {
    const summary = computeTraceSummary("trace-id", [
      makeSpan({
        start_timestamp: 1_700_000_000.0,
        timestamp: 1_700_000_001.0,
      }),
    ]);
    const output = stripAnsi(formatTraceSummary(summary));
    expect(output).toContain("Started");
  });

  test("omits start time when no valid timestamps", () => {
    const summary = computeTraceSummary("trace-id", [
      makeSpan({ start_timestamp: 0, timestamp: 0 }),
    ]);
    const output = stripAnsi(formatTraceSummary(summary));
    expect(output).not.toContain("Started");
  });
});

describe("formatTraceTable", () => {
  test("includes all transaction names", () => {
    const items = [
      makeTransaction({ transaction: "GET /api/users" }),
      makeTransaction({ transaction: "POST /api/data" }),
    ];
    const result = stripAnsi(formatTraceTable(items));
    expect(result).toContain("GET /api/users");
    expect(result).toContain("POST /api/data");
  });

  test("includes trace IDs", () => {
    const traceId = "a".repeat(32);
    const result = stripAnsi(
      formatTraceTable([makeTransaction({ trace: traceId })])
    );
    expect(result).toContain(traceId);
  });

  test("includes formatted durations", () => {
    const result = stripAnsi(
      formatTraceTable([makeTransaction({ "span.duration": 1500 })])
    );
    expect(result).toContain("1.50s");
  });

  test("shows 'unknown' for empty transaction", () => {
    const result = stripAnsi(
      formatTraceTable([makeTransaction({ transaction: "" })])
    );
    expect(result).toContain("unknown");
  });
});

// ---------------------------------------------------------------------------
// translateSpanQuery
// ---------------------------------------------------------------------------

describe("translateSpanQuery", () => {
  test("translates op: to span.op:", () => {
    expect(translateSpanQuery("op:db")).toBe("span.op:db");
  });

  test("translates duration: to span.duration:", () => {
    expect(translateSpanQuery("duration:>100ms")).toBe("span.duration:>100ms");
  });

  test("bare words pass through unchanged", () => {
    expect(translateSpanQuery("GET users")).toBe("GET users");
  });

  test("mixed shorthand and bare words", () => {
    expect(translateSpanQuery("op:http GET duration:>50ms")).toBe(
      "span.op:http GET span.duration:>50ms"
    );
  });

  test("native keys pass through unchanged", () => {
    expect(translateSpanQuery("description:fetch project:backend")).toBe(
      "description:fetch project:backend"
    );
  });

  test("transaction: passes through unchanged", () => {
    expect(translateSpanQuery("transaction:checkout")).toBe(
      "transaction:checkout"
    );
  });

  test("key translation is case-insensitive", () => {
    expect(translateSpanQuery("Op:db")).toBe("span.op:db");
    expect(translateSpanQuery("DURATION:>1s")).toBe("span.duration:>1s");
  });

  test("empty query returns empty string", () => {
    expect(translateSpanQuery("")).toBe("");
  });

  test("quoted values are preserved", () => {
    expect(translateSpanQuery('description:"GET /api"')).toBe(
      'description:"GET /api"'
    );
  });

  test("negated shorthand keys are translated correctly", () => {
    expect(translateSpanQuery("!op:db")).toBe("!span.op:db");
    expect(translateSpanQuery("!duration:>100ms")).toBe(
      "!span.duration:>100ms"
    );
  });

  test("negated non-alias keys pass through unchanged", () => {
    expect(translateSpanQuery("!description:fetch")).toBe("!description:fetch");
  });
});

// ---------------------------------------------------------------------------
// findSpanById
// ---------------------------------------------------------------------------

describe("findSpanById", () => {
  test("finds root-level span", () => {
    const spans = [makeSpan({ span_id: "a1b2c3d4e5f67890" })];
    const result = findSpanById(spans, "a1b2c3d4e5f67890");
    expect(result).not.toBeNull();
    expect(result?.span.span_id).toBe("a1b2c3d4e5f67890");
    expect(result?.depth).toBe(0);
    expect(result?.ancestors).toEqual([]);
  });

  test("finds nested span with ancestor chain", () => {
    const child = makeSpan({ span_id: "childid123456789" });
    const root = makeSpan({
      span_id: "rootid1234567890",
      children: [child],
    });
    const result = findSpanById([root], "childid123456789");
    expect(result).not.toBeNull();
    expect(result?.span.span_id).toBe("childid123456789");
    expect(result?.depth).toBe(1);
    expect(result?.ancestors).toHaveLength(1);
    expect(result?.ancestors[0]?.span_id).toBe("rootid1234567890");
  });

  test("case-insensitive matching (API returns uppercase)", () => {
    const spans = [makeSpan({ span_id: "A1B2C3D4E5F67890" })];
    const result = findSpanById(spans, "a1b2c3d4e5f67890");
    expect(result).not.toBeNull();
    expect(result?.span.span_id).toBe("A1B2C3D4E5F67890");
  });

  test("returns null for non-existent span ID", () => {
    const spans = [makeSpan({ span_id: "a1b2c3d4e5f67890" })];
    const result = findSpanById(spans, "0000000000000000");
    expect(result).toBeNull();
  });

  test("handles span with undefined span_id gracefully", () => {
    const spans = [
      { start_timestamp: 1000, children: [] } as unknown as TraceSpan,
    ];
    const result = findSpanById(spans, "a1b2c3d4e5f67890");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeSpanDurationMs
// ---------------------------------------------------------------------------

describe("computeSpanDurationMs", () => {
  test("returns duration when present", () => {
    const span = { duration: 123.45, start_timestamp: 1000 } as TraceSpan;
    expect(computeSpanDurationMs(span)).toBe(123.45);
  });

  test("falls back to timestamp arithmetic", () => {
    const span = {
      start_timestamp: 1000,
      timestamp: 1001.5,
    } as TraceSpan;
    expect(computeSpanDurationMs(span)).toBe(1500);
  });

  test("prefers end_timestamp over timestamp", () => {
    const span = {
      start_timestamp: 1000,
      end_timestamp: 1002,
      timestamp: 1001,
    } as TraceSpan;
    expect(computeSpanDurationMs(span)).toBe(2000);
  });

  test("returns undefined when no duration data", () => {
    const span = { start_timestamp: 1000 } as TraceSpan;
    expect(computeSpanDurationMs(span)).toBeUndefined();
  });

  test("returns undefined for negative duration", () => {
    const span = {
      start_timestamp: 1002,
      timestamp: 1000,
    } as TraceSpan;
    expect(computeSpanDurationMs(span)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// spanListItemToFlatSpan
// ---------------------------------------------------------------------------

describe("spanListItemToFlatSpan", () => {
  test("maps all fields correctly", () => {
    const item: SpanListItem = {
      id: "a1b2c3d4e5f67890",
      parent_span: "1234567890abcdef",
      "span.op": "http.client",
      description: "GET /api/users",
      "span.duration": 245.5,
      timestamp: "2024-01-15T10:30:00+00:00",
      project: "backend",
      transaction: "/api/users",
      trace: "aaaa1111bbbb2222cccc3333dddd4444",
    };

    const flat = spanListItemToFlatSpan(item);
    expect(flat.span_id).toBe("a1b2c3d4e5f67890");
    expect(flat.parent_span_id).toBe("1234567890abcdef");
    expect(flat.op).toBe("http.client");
    expect(flat.description).toBe("GET /api/users");
    expect(flat.duration_ms).toBe(245.5);
    expect(flat.project_slug).toBe("backend");
    expect(flat.transaction).toBe("/api/users");
  });

  test("handles missing optional fields", () => {
    const item: SpanListItem = {
      id: "a1b2c3d4e5f67890",
      timestamp: "2024-01-15T10:30:00+00:00",
      trace: "aaaa1111bbbb2222cccc3333dddd4444",
      project: "backend",
    };

    const flat = spanListItemToFlatSpan(item);
    expect(flat.span_id).toBe("a1b2c3d4e5f67890");
    expect(flat.parent_span_id).toBeUndefined();
    expect(flat.op).toBeUndefined();
    expect(flat.description).toBeUndefined();
    expect(flat.duration_ms).toBeUndefined();
  });
});
