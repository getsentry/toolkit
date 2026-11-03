import { describe, expect, it } from "vitest";
import {
  MINUTE_STATS_INTERVALS,
  ONE_DAY_SECONDS,
  statsPeriodToSeconds,
} from "./stats-period";

describe("statsPeriodToSeconds", () => {
  it.each([
    ["30s", 30],
    ["5m", 300],
    ["24h", 86_400],
    ["7d", 604_800],
    ["2w", 1_209_600],
  ])("parses %s", (period, seconds) => {
    expect(statsPeriodToSeconds(period)).toBe(seconds);
  });

  it.each(["", "1hr", "hourly", "1.5h", "h"])("rejects %s", (period) => {
    expect(statsPeriodToSeconds(period)).toBeUndefined();
  });
});

describe("MINUTE_STATS_INTERVALS", () => {
  it("lists whole-minute intervals that divide one day, ascending", () => {
    const seconds = MINUTE_STATS_INTERVALS.map((value) =>
      statsPeriodToSeconds(value),
    );
    for (const value of seconds) {
      expect(value).toBeDefined();
      expect(value! % 60).toBe(0);
      expect(ONE_DAY_SECONDS % value!).toBe(0);
    }
    expect(seconds).toEqual([...seconds].sort((a, b) => a! - b!));
  });
});
