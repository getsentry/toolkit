/**
 * Unit tests for the time-range module.
 *
 * Core invariants (round-trips, operator equivalence, mutual exclusivity)
 * are tested via property-based tests in time-range.property.test.ts.
 * These tests focus on edge cases, validation errors, and specific
 * normalization behavior.
 */

import { describe, expect, test, vi } from "vitest";
import {
  parseDate,
  parsePeriod,
  serializeTimeRange,
  timeRangeToApiParams,
  timeRangeToSeconds,
} from "../../src/lib/time-range.js";

test("keeps generated period help stable across month boundaries", async () => {
  try {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T23:59:59Z"));
    vi.resetModules();
    const before = (await import("../../src/lib/time-range.js")).PERIOD_BRIEF;

    vi.setSystemTime(new Date("2026-10-01T00:00:01Z"));
    vi.resetModules();
    const after = (await import("../../src/lib/time-range.js")).PERIOD_BRIEF;

    expect(after).toBe(before);
  } finally {
    vi.useRealTimers();
    vi.resetModules();
  }
});

// ---------------------------------------------------------------------------
// parsePeriod — relative durations (backward compatibility)
// ---------------------------------------------------------------------------

describe("parsePeriod: relative durations", () => {
  const validPeriods = [
    "1m",
    "30m",
    "1h",
    "24h",
    "7d",
    "14d",
    "30d",
    "90d",
    "1w",
    "2w",
  ];

  for (const period of validPeriods) {
    test(`parses "${period}" as relative`, () => {
      const result = parsePeriod(period);
      expect(result).toEqual({ type: "relative", period });
    });
  }

  test("rejects zero duration", () => {
    expect(() => parsePeriod("0d")).toThrow("cannot be zero");
    expect(() => parsePeriod("0h")).toThrow("cannot be zero");
    expect(() => parsePeriod("0m")).toThrow("cannot be zero");
  });

  test("rejects invalid units", () => {
    expect(() => parsePeriod("7x")).toThrow("Invalid period");
    expect(() => parsePeriod("24z")).toThrow("Invalid period");
  });

  test("rejects empty string", () => {
    expect(() => parsePeriod("")).toThrow("Empty period");
    expect(() => parsePeriod("  ")).toThrow("Empty period");
  });

  test("rejects bare date without operator or range", () => {
    expect(() => parsePeriod("2024-01-01")).toThrow("Invalid period");
  });
});

// ---------------------------------------------------------------------------
// parsePeriod — ".." range syntax
// ---------------------------------------------------------------------------

describe("parsePeriod: range syntax", () => {
  test('parses full range "start..end"', () => {
    const result = parsePeriod("2024-01-01..2024-02-01");
    expect(result.type).toBe("absolute");
    if (result.type === "absolute") {
      expect(result.start).toContain("2024-01-01");
      expect(result.end).toContain("2024-02-01");
    }
  });

  test('parses open-ended start "date.."', () => {
    const result = parsePeriod("2024-06-01..");
    expect(result.type).toBe("absolute");
    if (result.type === "absolute") {
      expect(result.start).toContain("2024-06-01");
      expect(result.end).toBeUndefined();
    }
  });

  test('parses open-ended end "..date"', () => {
    const result = parsePeriod("..2024-03-01");
    expect(result.type).toBe("absolute");
    if (result.type === "absolute") {
      expect(result.start).toBeUndefined();
      expect(result.end).toContain("2024-03-01");
    }
  });

  test('rejects bare ".."', () => {
    expect(() => parsePeriod("..")).toThrow("Empty range");
  });

  test("rejects end before start", () => {
    expect(() => parsePeriod("2024-06-01..2024-01-01")).toThrow(
      "is after end date",
    );
  });

  test("rejects invalid dates in range", () => {
    expect(() => parsePeriod("not-a-date..2024-01-01")).toThrow("Invalid");
    expect(() => parsePeriod("2024-01-01..not-a-date")).toThrow("Invalid");
  });

  test('rejects mixed relative in range "7d..14d"', () => {
    expect(() => parsePeriod("7d..14d")).toThrow("Invalid");
  });
});

// ---------------------------------------------------------------------------
// parsePeriod — comparison operators
// ---------------------------------------------------------------------------

describe("parsePeriod: comparison operators", () => {
  test('">=date" returns absolute with start', () => {
    const result = parsePeriod(">=2024-01-15");
    expect(result.type).toBe("absolute");
    if (result.type === "absolute") {
      expect(result.start).toContain("2024-01-15T00:00:00");
      expect(result.end).toBeUndefined();
    }
  });

  test('">date" returns absolute with next-day start', () => {
    const result = parsePeriod(">2024-01-15");
    expect(result.type).toBe("absolute");
    if (result.type === "absolute") {
      expect(result.start).toContain("2024-01-16T00:00:00");
      expect(result.end).toBeUndefined();
    }
  });

  test('"<=date" returns absolute with end', () => {
    const result = parsePeriod("<=2024-02-01");
    expect(result.type).toBe("absolute");
    if (result.type === "absolute") {
      expect(result.start).toBeUndefined();
      expect(result.end).toContain("2024-02-01T23:59:59");
    }
  });

  test('"<date" returns absolute with prev-day end', () => {
    const result = parsePeriod("<2024-02-01");
    expect(result.type).toBe("absolute");
    if (result.type === "absolute") {
      expect(result.start).toBeUndefined();
      expect(result.end).toContain("2024-01-31T23:59:59");
    }
  });

  test('"> exclusive" differs from ">= inclusive" for date-only', () => {
    const exclusive = parsePeriod(">2024-01-15");
    const inclusive = parsePeriod(">=2024-01-15");
    if (exclusive.type === "absolute" && inclusive.type === "absolute") {
      // Exclusive start should be strictly later than inclusive start
      expect(new Date(exclusive.start!).getTime()).toBeGreaterThan(
        new Date(inclusive.start!).getTime(),
      );
    }
  });

  test('"< exclusive" differs from "<= inclusive" for date-only', () => {
    const exclusive = parsePeriod("<2024-02-01");
    const inclusive = parsePeriod("<=2024-02-01");
    if (exclusive.type === "absolute" && inclusive.type === "absolute") {
      // Exclusive end should be strictly earlier than inclusive end
      expect(new Date(exclusive.end!).getTime()).toBeLessThan(
        new Date(inclusive.end!).getTime(),
      );
    }
  });

  test("rejects operator without date", () => {
    expect(() => parsePeriod(">")).toThrow("Missing date");
    expect(() => parsePeriod(">=")).toThrow("Missing date");
    expect(() => parsePeriod("<")).toThrow("Missing date");
    expect(() => parsePeriod("<=")).toThrow("Missing date");
  });

  test("datetime with operator passes through as-is (no day shift)", () => {
    const result = parsePeriod(">2024-01-01T12:00:00Z");
    if (result.type === "absolute") {
      // Datetime with TZ → no next-day shift, converted to ISO
      expect(result.start).toBe("2024-01-01T12:00:00.000Z");
    }
  });
});

// ---------------------------------------------------------------------------
// parseDate — timezone handling
// ---------------------------------------------------------------------------

describe("parseDate: output format", () => {
  test("date-only outputs UTC ISO string via local interpretation", () => {
    const result = parseDate("2024-06-15", "start");
    // Output is always .toISOString() format (UTC, ends with Z)
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(new Date(result).getTime())).toBe(false);
    // Should represent local midnight of 2024-06-15 converted to UTC
    const d = new Date("2024-06-15T00:00:00"); // local time
    expect(result).toBe(d.toISOString());
  });

  test("datetime with Z is normalized to ISO", () => {
    const result = parseDate("2024-06-15T12:00:00Z", "start");
    expect(result).toBe("2024-06-15T12:00:00.000Z");
  });

  test("datetime with +offset is converted to UTC", () => {
    const result = parseDate("2024-06-15T12:00:00+05:30", "start");
    // +05:30 means 12:00 local = 06:30 UTC
    expect(result).toBe("2024-06-15T06:30:00.000Z");
  });

  test("datetime with -offset is converted to UTC", () => {
    const result = parseDate("2024-06-15T12:00:00-08:00", "start");
    // -08:00 means 12:00 local = 20:00 UTC
    expect(result).toBe("2024-06-15T20:00:00.000Z");
  });

  test("datetime without TZ is treated as local time", () => {
    const result = parseDate("2024-06-15T12:00:00", "start");
    // new Date() without Z treats as local time
    const expected = new Date("2024-06-15T12:00:00").toISOString();
    expect(result).toBe(expected);
  });

  test("space separator is accepted as T alternative", () => {
    const withSpace = parseDate("2024-06-15 12:00:00Z", "start");
    const withT = parseDate("2024-06-15T12:00:00Z", "start");
    expect(withSpace).toBe(withT);
  });

  test("rejects invalid date", () => {
    expect(() => parseDate("not-a-date", "start")).toThrow("Invalid");
  });

  test("rejects empty string", () => {
    expect(() => parseDate("", "start")).toThrow("Empty date");
  });
});

// ---------------------------------------------------------------------------
// timeRangeToApiParams
// ---------------------------------------------------------------------------

describe("timeRangeToApiParams", () => {
  test("relative → statsPeriod only", () => {
    const params = timeRangeToApiParams({ type: "relative", period: "7d" });
    expect(params).toEqual({ statsPeriod: "7d" });
    expect(params.start).toBeUndefined();
    expect(params.end).toBeUndefined();
  });

  test("absolute full range → start + end, no statsPeriod", () => {
    const params = timeRangeToApiParams({
      type: "absolute",
      start: "2024-01-01T00:00:00Z",
      end: "2024-02-01T23:59:59Z",
    });
    expect(params.statsPeriod).toBeUndefined();
    expect(params.start).toBe("2024-01-01T00:00:00Z");
    expect(params.end).toBe("2024-02-01T23:59:59Z");
  });

  test("absolute start-only → start + auto-filled end (now)", () => {
    const before = new Date();
    const params = timeRangeToApiParams({
      type: "absolute",
      start: "2024-01-01T00:00:00Z",
    });
    const after = new Date();
    expect(params.start).toBe("2024-01-01T00:00:00Z");
    expect(params.statsPeriod).toBeUndefined();
    // end should be filled with "now"
    expect(params.end).toBeDefined();
    const endDate = new Date(params.end!);
    expect(endDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(endDate.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  test("absolute end-only → end + auto-filled start (90 days before end)", () => {
    const params = timeRangeToApiParams({
      type: "absolute",
      end: "2024-02-01T23:59:59Z",
    });
    expect(params.end).toBe("2024-02-01T23:59:59Z");
    expect(params.statsPeriod).toBeUndefined();
    // start should be filled with 90 days before end
    expect(params.start).toBeDefined();
    const startDate = new Date(params.start!);
    const expectedStart = new Date("2024-02-01T23:59:59Z");
    expectedStart.setUTCDate(expectedStart.getUTCDate() - 90);
    expect(startDate.toISOString()).toBe(expectedStart.toISOString());
  });
});

// ---------------------------------------------------------------------------
// serializeTimeRange
// ---------------------------------------------------------------------------

describe("serializeTimeRange", () => {
  test("relative → 'rel:7d'", () => {
    expect(serializeTimeRange({ type: "relative", period: "7d" })).toBe(
      "rel:7d",
    );
  });

  test("absolute full range → 'abs:start..end' in UTC", () => {
    const result = serializeTimeRange({
      type: "absolute",
      start: "2024-01-01T00:00:00Z",
      end: "2024-02-01T23:59:59Z",
    });
    expect(result).toMatch(/^abs:.*\.\..*$/);
    // UTC normalization
    expect(result).toContain("2024-01-01T00:00:00.000Z");
  });

  test("open-ended start → 'abs:start..'", () => {
    const result = serializeTimeRange({
      type: "absolute",
      start: "2024-06-01T00:00:00Z",
    });
    expect(result).toMatch(/^abs:.*\.\.$/);
  });

  test("open-ended end → 'abs:..end'", () => {
    const result = serializeTimeRange({
      type: "absolute",
      end: "2024-03-01T23:59:59Z",
    });
    expect(result).toMatch(/^abs:\.\..*$/);
  });

  test("operator equivalences serialize identically", () => {
    // >=2024-01-01 and 2024-01-01.. should produce the same serialization
    const fromOp = parsePeriod(">=2024-01-01");
    const fromRange = parsePeriod("2024-01-01..");
    expect(serializeTimeRange(fromOp)).toBe(serializeTimeRange(fromRange));
  });
});

// ---------------------------------------------------------------------------
// timeRangeToSeconds
// ---------------------------------------------------------------------------

describe("timeRangeToSeconds", () => {
  test("relative 7d → 604800", () => {
    expect(timeRangeToSeconds({ type: "relative", period: "7d" })).toBe(
      604_800,
    );
  });

  test("relative 24h → 86400", () => {
    expect(timeRangeToSeconds({ type: "relative", period: "24h" })).toBe(
      86_400,
    );
  });

  test("relative 1w → 604800", () => {
    expect(timeRangeToSeconds({ type: "relative", period: "1w" })).toBe(
      604_800,
    );
  });

  test("absolute 7-day range → 604800", () => {
    const result = timeRangeToSeconds({
      type: "absolute",
      start: "2024-01-01T00:00:00Z",
      end: "2024-01-08T00:00:00Z",
    });
    expect(result).toBe(604_800);
  });

  test("open-ended range → undefined", () => {
    expect(
      timeRangeToSeconds({
        type: "absolute",
        start: "2024-01-01T00:00:00Z",
      }),
    ).toBeUndefined();
    expect(
      timeRangeToSeconds({
        type: "absolute",
        end: "2024-02-01T00:00:00Z",
      }),
    ).toBeUndefined();
  });
});
