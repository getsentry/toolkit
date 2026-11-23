import { describe, expect, it } from "vitest";
import { statsIntervalToSeconds, statsPeriodToSeconds } from "./stats-period";

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

describe("statsIntervalToSeconds", () => {
  it.each([
    ["60", 60],
    ["30s", 30],
    ["1h", 3600],
    ["1d", 86_400],
  ])("parses %s", (interval, seconds) => {
    expect(statsIntervalToSeconds(interval)).toBe(seconds);
  });

  it.each(["", "1hr", "1.5h", "h"])("rejects %s", (interval) => {
    expect(statsIntervalToSeconds(interval)).toBeUndefined();
  });
});
