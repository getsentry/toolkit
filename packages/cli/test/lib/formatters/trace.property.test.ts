/**
 * Property-Based Tests for Trace Formatters
 *
 * Uses fast-check to verify invariants of trace formatting functions
 * that should hold for any valid input.
 */

import {
  array,
  constantFrom,
  double,
  assert as fcAssert,
  option,
  property,
  record,
  stringMatching,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  computeTraceSummary,
  formatTraceDuration,
  formatTraceRow,
  formatTraceSummary,
  formatTracesHeader,
} from "../../../src/lib/formatters/trace.js";
import type {
  TraceSpan,
  TransactionListItem,
} from "../../../src/types/index.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

/** Valid positive durations in milliseconds */
const positiveDurationArb = double({ min: 0, max: 1e9, noNaN: true });

/** Invalid durations that should produce "—" */
const invalidDurationArb = constantFrom(
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -1,
  -1000
);

/** 32-char hex string for trace/event IDs */
const hexId32Arb = stringMatching(/^[a-f0-9]{32}$/);

/** Short alphanumeric slugs */
const slugArb = stringMatching(/^[a-z][a-z0-9-]{1,20}$/);

/** Transaction name */
const transactionNameArb = stringMatching(/^[A-Z]{3,6} \/[a-z/]{1,40}$/);

/** ISO timestamp string */
const isoTimestampArb = constantFrom(
  "2025-01-15T10:30:00Z",
  "2024-12-01T00:00:00Z",
  "2025-06-15T23:59:59Z"
);

/** Realistic Unix timestamp in seconds (2020-2030) */
const unixTimestampArb = double({
  min: 1_577_836_800,
  max: 1_893_456_000,
  noNaN: true,
});

/** Generate a TransactionListItem */
const transactionItemArb = record({
  trace: hexId32Arb,
  id: hexId32Arb,
  transaction: transactionNameArb,
  timestamp: isoTimestampArb,
  "span.duration": positiveDurationArb,
  project: slugArb,
}) as unknown as import("fast-check").Arbitrary<TransactionListItem>;

/** Generate a flat TraceSpan (no children) */
function makeSpanArb(): import("fast-check").Arbitrary<TraceSpan> {
  return record({
    span_id: hexId32Arb,
    op: option(
      constantFrom("http.server", "db.query", "cache.get", "http.client"),
      {
        nil: undefined,
      }
    ),
    description: option(
      constantFrom("GET /api", "SELECT *", "Redis GET", null),
      {
        nil: undefined,
      }
    ),
    start_timestamp: unixTimestampArb,
    timestamp: unixTimestampArb,
    project_slug: option(slugArb, { nil: undefined }),
    transaction: option(transactionNameArb, { nil: undefined }),
    "transaction.op": option(
      constantFrom("http.server", "browser", "celery_task"),
      { nil: undefined }
    ),
  }) as unknown as import("fast-check").Arbitrary<TraceSpan>;
}

/** Generate a list of flat TraceSpans (1-10) */
const spanListArb = array(makeSpanArb(), { minLength: 1, maxLength: 10 });

describe("property: formatTraceDuration", () => {
  test("positive durations always produce non-empty string without dash", () => {
    fcAssert(
      property(positiveDurationArb, (ms) => {
        const result = formatTraceDuration(ms);
        expect(result.length).toBeGreaterThan(0);
        expect(result).not.toBe("—");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("invalid durations always produce dash", () => {
    fcAssert(
      property(invalidDurationArb, (ms) => {
        expect(formatTraceDuration(ms)).toBe("—");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is deterministic: same input always gives same output", () => {
    fcAssert(
      property(positiveDurationArb, (ms) => {
        expect(formatTraceDuration(ms)).toBe(formatTraceDuration(ms));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("larger durations never produce shorter format units", () => {
    // Durations >= 60_000ms should contain 'm', durations < 1000 should contain 'ms'
    fcAssert(
      property(positiveDurationArb, (ms) => {
        const result = formatTraceDuration(ms);
        if (ms < 1000) {
          expect(result).toContain("ms");
        } else if (ms >= 60_000) {
          expect(result).toContain("m");
        } else {
          expect(result).toContain("s");
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: formatTracesHeader", () => {
  test("is deterministic and always non-empty", () => {
    const a = formatTracesHeader();
    const b = formatTracesHeader();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe("property: formatTraceRow", () => {
  test("always contains the trace ID", () => {
    fcAssert(
      property(transactionItemArb, (item) => {
        const row = formatTraceRow(item);
        // Trace ID is sliced to 32 chars max
        expect(row).toContain(item.trace.slice(0, 32));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("always ends with newline", () => {
    fcAssert(
      property(transactionItemArb, (item) => {
        expect(formatTraceRow(item).endsWith("\n")).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is deterministic", () => {
    fcAssert(
      property(transactionItemArb, (item) => {
        expect(formatTraceRow(item)).toBe(formatTraceRow(item));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: computeTraceSummary", () => {
  test("span count equals total number of spans (flat, no children)", () => {
    fcAssert(
      property(hexId32Arb, spanListArb, (traceId, spans) => {
        const summary = computeTraceSummary(traceId, spans);
        expect(summary.spanCount).toBe(spans.length);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("traceId is preserved in summary", () => {
    fcAssert(
      property(hexId32Arb, spanListArb, (traceId, spans) => {
        const summary = computeTraceSummary(traceId, spans);
        expect(summary.traceId).toBe(traceId);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("duration is non-negative or NaN (never negative finite)", () => {
    fcAssert(
      property(hexId32Arb, spanListArb, (traceId, spans) => {
        const summary = computeTraceSummary(traceId, spans);
        if (Number.isFinite(summary.duration)) {
          expect(summary.duration).toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("projects are deduplicated", () => {
    fcAssert(
      property(hexId32Arb, spanListArb, (traceId, spans) => {
        const summary = computeTraceSummary(traceId, spans);
        const uniqueProjects = new Set(summary.projects);
        expect(uniqueProjects.size).toBe(summary.projects.length);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is deterministic", () => {
    fcAssert(
      property(hexId32Arb, spanListArb, (traceId, spans) => {
        const a = computeTraceSummary(traceId, spans);
        const b = computeTraceSummary(traceId, spans);
        expect(a).toEqual(b);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty spans array produces zero span count", () => {
    fcAssert(
      property(hexId32Arb, (traceId) => {
        const summary = computeTraceSummary(traceId, []);
        expect(summary.spanCount).toBe(0);
        expect(summary.projects).toEqual([]);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

/** Strip ANSI escape codes */
function stripAnsi(str: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control chars
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("property: formatTraceSummary", () => {
  test("always contains the trace ID", () => {
    fcAssert(
      property(hexId32Arb, spanListArb, (traceId, spans) => {
        const summary = computeTraceSummary(traceId, spans);
        const output = stripAnsi(formatTraceSummary(summary));
        expect(output).toContain(traceId);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("always contains Duration label", () => {
    fcAssert(
      property(hexId32Arb, spanListArb, (traceId, spans) => {
        const summary = computeTraceSummary(traceId, spans);
        const output = stripAnsi(formatTraceSummary(summary));
        expect(output).toContain("Duration");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("always contains Spans label", () => {
    fcAssert(
      property(hexId32Arb, spanListArb, (traceId, spans) => {
        const summary = computeTraceSummary(traceId, spans);
        const output = stripAnsi(formatTraceSummary(summary));
        expect(output).toContain("Spans");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns a string", () => {
    fcAssert(
      property(hexId32Arb, spanListArb, (traceId, spans) => {
        const summary = computeTraceSummary(traceId, spans);
        const result = formatTraceSummary(summary);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is deterministic", () => {
    fcAssert(
      property(hexId32Arb, spanListArb, (traceId, spans) => {
        const summary = computeTraceSummary(traceId, spans);
        const a = formatTraceSummary(summary);
        const b = formatTraceSummary(summary);
        expect(a).toEqual(b);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
