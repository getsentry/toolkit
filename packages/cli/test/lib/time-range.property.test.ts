/**
 * Property-based tests for the time-range module.
 *
 * Tests invariants that should hold for any valid input using fast-check.
 */

import {
  array,
  constantFrom,
  date,
  assert as fcAssert,
  integer,
  oneof,
  property,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  parsePeriod,
  serializeTimeRange,
  timeRangeToApiParams,
  timeRangeToSeconds,
} from "../../src/lib/time-range.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generate a valid relative period string like "7d", "24h", "1m" */
const relativePeriodArb = integer({ min: 1, max: 999 }).chain((n) =>
  constantFrom("m", "h", "d", "w").map((u) => `${n}${u}`)
);

/** Generate an ISO date string (YYYY-MM-DD) in a sensible range */
const isoDateArb = date({
  min: new Date("2020-01-02"),
  max: new Date("2030-12-30"),
  noInvalidDate: true,
}).map((d) => d.toISOString().slice(0, 10));

/** Generate a pair of sorted ISO date strings for valid ranges */
const sortedDatePairArb = array(isoDateArb, { minLength: 2, maxLength: 2 }).map(
  (dates) => {
    const sorted = [...dates].sort();
    // Ensure they're different (no zero-length range issues)
    if (sorted[0] === sorted[1]) {
      const d = new Date(sorted[1]!);
      d.setDate(d.getDate() + 1);
      sorted[1] = d.toISOString().slice(0, 10);
    }
    return sorted as [string, string];
  }
);

// ---------------------------------------------------------------------------
// Properties: parsePeriod — relative
// ---------------------------------------------------------------------------

describe("property: parsePeriod relative", () => {
  test("all valid relative periods parse as { type: relative }", () => {
    fcAssert(
      property(relativePeriodArb, (period) => {
        const result = parsePeriod(period);
        expect(result.type).toBe("relative");
        if (result.type === "relative") {
          expect(result.period).toBe(period);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// Properties: parsePeriod — range syntax
// ---------------------------------------------------------------------------

describe("property: parsePeriod range syntax", () => {
  test("full range (date..date) parses as absolute with both bounds", () => {
    fcAssert(
      property(sortedDatePairArb, ([start, end]) => {
        const result = parsePeriod(`${start}..${end}`);
        expect(result.type).toBe("absolute");
        if (result.type === "absolute") {
          expect(result.start).toBeDefined();
          expect(result.end).toBeDefined();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("open-ended start (date..) parses as absolute with start only", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        const result = parsePeriod(`${d}..`);
        expect(result.type).toBe("absolute");
        if (result.type === "absolute") {
          expect(result.start).toBeDefined();
          expect(result.end).toBeUndefined();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("open-ended end (..date) parses as absolute with end only", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        const result = parsePeriod(`..${d}`);
        expect(result.type).toBe("absolute");
        if (result.type === "absolute") {
          expect(result.start).toBeUndefined();
          expect(result.end).toBeDefined();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// Properties: parsePeriod — comparison operators
// ---------------------------------------------------------------------------

describe("property: parsePeriod operators", () => {
  test(">= parses as absolute with start", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        const result = parsePeriod(`>=${d}`);
        expect(result.type).toBe("absolute");
        if (result.type === "absolute") {
          expect(result.start).toBeDefined();
          expect(result.end).toBeUndefined();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("> parses as absolute with start (next day for date-only)", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        const result = parsePeriod(`>${d}`);
        expect(result.type).toBe("absolute");
        if (result.type === "absolute") {
          expect(result.start).toBeDefined();
          expect(result.end).toBeUndefined();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("<= parses as absolute with end", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        const result = parsePeriod(`<=${d}`);
        expect(result.type).toBe("absolute");
        if (result.type === "absolute") {
          expect(result.start).toBeUndefined();
          expect(result.end).toBeDefined();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("< parses as absolute with end (prev day for date-only)", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        const result = parsePeriod(`<${d}`);
        expect(result.type).toBe("absolute");
        if (result.type === "absolute") {
          expect(result.start).toBeUndefined();
          expect(result.end).toBeDefined();
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("> produces strictly later start than >= for date-only", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        const excl = parsePeriod(`>${d}`);
        const incl = parsePeriod(`>=${d}`);
        if (excl.type === "absolute" && incl.type === "absolute") {
          const exclTime = new Date(excl.start!).getTime();
          const inclTime = new Date(incl.start!).getTime();
          expect(exclTime).toBeGreaterThan(inclTime);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("< produces strictly earlier end than <= for date-only", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        const excl = parsePeriod(`<${d}`);
        const incl = parsePeriod(`<=${d}`);
        if (excl.type === "absolute" && incl.type === "absolute") {
          const exclTime = new Date(excl.end!).getTime();
          const inclTime = new Date(incl.end!).getTime();
          expect(exclTime).toBeLessThan(inclTime);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// Properties: timeRangeToApiParams — mutual exclusivity
// ---------------------------------------------------------------------------

describe("property: timeRangeToApiParams mutual exclusivity", () => {
  const timeRangeArb = oneof(
    relativePeriodArb.map((p) => parsePeriod(p)),
    sortedDatePairArb.map(([s, e]) => parsePeriod(`${s}..${e}`)),
    isoDateArb.map((d) => parsePeriod(`${d}..`)),
    isoDateArb.map((d) => parsePeriod(`..${d}`)),
    isoDateArb.map((d) => parsePeriod(`>=${d}`)),
    isoDateArb.map((d) => parsePeriod(`<=${d}`))
  );

  test("statsPeriod and start/end are never both set", () => {
    fcAssert(
      property(timeRangeArb, (range) => {
        const params = timeRangeToApiParams(range);
        if (params.statsPeriod) {
          expect(params.start).toBeUndefined();
          expect(params.end).toBeUndefined();
        } else {
          // At least one of start/end should be defined for absolute
          expect(params.start !== undefined || params.end !== undefined).toBe(
            true
          );
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// Properties: serialization
// ---------------------------------------------------------------------------

describe("property: serializeTimeRange", () => {
  test("deterministic — same input produces same output", () => {
    fcAssert(
      property(relativePeriodArb, (period) => {
        const range = parsePeriod(period);
        expect(serializeTimeRange(range)).toBe(serializeTimeRange(range));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test(">= and .. produce same serialization for date-only", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        const fromOp = parsePeriod(`>=${d}`);
        const fromRange = parsePeriod(`${d}..`);
        expect(serializeTimeRange(fromOp)).toBe(serializeTimeRange(fromRange));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("<= and ..date produce same serialization for date-only", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        const fromOp = parsePeriod(`<=${d}`);
        const fromRange = parsePeriod(`..${d}`);
        expect(serializeTimeRange(fromOp)).toBe(serializeTimeRange(fromRange));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// ---------------------------------------------------------------------------
// Properties: timeRangeToSeconds
// ---------------------------------------------------------------------------

describe("property: timeRangeToSeconds", () => {
  test("relative durations produce positive seconds", () => {
    fcAssert(
      property(relativePeriodArb, (period) => {
        const range = parsePeriod(period);
        const seconds = timeRangeToSeconds(range);
        expect(seconds).toBeDefined();
        expect(seconds).toBeGreaterThan(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("full absolute ranges produce non-negative seconds", () => {
    fcAssert(
      property(sortedDatePairArb, ([start, end]) => {
        const range = parsePeriod(`${start}..${end}`);
        const seconds = timeRangeToSeconds(range);
        expect(seconds).toBeDefined();
        expect(seconds).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("open-ended ranges return undefined", () => {
    fcAssert(
      property(isoDateArb, (d) => {
        expect(timeRangeToSeconds(parsePeriod(`${d}..`))).toBeUndefined();
        expect(timeRangeToSeconds(parsePeriod(`..${d}`))).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
