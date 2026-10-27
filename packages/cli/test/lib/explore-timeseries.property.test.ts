/** Interval selection invariants across relative and absolute time ranges. */

import { assert as fcAssert, integer, property } from "fast-check";
import { describe, expect, test } from "vitest";
import { resolveTimeSeriesInterval } from "../../src/lib/explore-timeseries.js";
import { timeRangeToSeconds } from "../../src/lib/time-range.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

describe("Explore time series intervals", () => {
  test("automatic buckets fit windows through the supported maximum for either date syntax", () => {
    fcAssert(
      property(integer({ min: 15, max: 10_100 * 86_400 }), (seconds) => {
        const start = Date.parse("2026-01-01T00:00:00Z");
        const relative = resolveTimeSeriesInterval({
          statsPeriod: `${seconds}s`,
        });
        const absolute = resolveTimeSeriesInterval({
          start: new Date(start).toISOString(),
          end: new Date(start + seconds * 1000).toISOString(),
        });
        expect(absolute).toBe(relative);
        const bucketSeconds = timeRangeToSeconds({
          type: "relative",
          period: relative,
        })!;
        expect(bucketSeconds).toBeGreaterThanOrEqual(15);
        expect(bucketSeconds).toBeLessThanOrEqual(seconds);
        expect(Math.ceil(seconds / bucketSeconds)).toBeLessThanOrEqual(10_100);
      }),
      {
        numRuns: DEFAULT_NUM_RUNS,
        examples: [[10_100 * 10_800], [10_100 * 10_800 + 1], [10_100 * 86_400]],
      },
    );
  });

  test("keeps a requested interval even when the automatic choice differs", () => {
    fcAssert(
      property(integer({ min: 1, max: 1000 }), (buckets) => {
        expect(
          resolveTimeSeriesInterval({ statsPeriod: `${buckets * 15}m` }, "15m"),
        ).toBe("15m");
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("rejects an explicit granularity beyond the server's bucket budget", () => {
    expect(() =>
      resolveTimeSeriesInterval({ statsPeriod: "90d" }, "15s"),
    ).toThrow("too many time buckets");
  });

  test("rejects windows beyond the budget of the largest supported interval", () => {
    expect(() =>
      resolveTimeSeriesInterval({ statsPeriod: `${10_100 * 86_400 + 1}s` }),
    ).toThrow("too many time buckets");
  });
});
