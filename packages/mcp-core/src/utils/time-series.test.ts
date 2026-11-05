import { describe, expect, it } from "vitest";
import { TimeSeriesConfigSchema } from "./time-series";

describe("time series configuration", () => {
  it("accepts automatic EMA factor and ASAP window selection", () => {
    expect(
      TimeSeriesConfigSchema.parse({
        axes: [
          { yAxis: "count()", transformations: ["smooth(ema,3)"] },
          { yAxis: "count()", transformations: ["smooth(asap)"] },
          { yAxis: "count()", transformations: ["smooth(asap,10)"] },
        ],
      }).axes,
    ).toEqual([
      { yAxis: "count()", transformations: ["smooth(ema,3)"] },
      { yAxis: "count()", transformations: ["smooth(asap)"] },
      { yAxis: "count()", transformations: ["smooth(asap,10)"] },
    ]);
  });

  it.each([
    ["fill(zero)", "fill(locf)"],
    ["smooth(sma,2)", "smooth(ema,2)"],
    ["smooth(sma,0)"],
    ["smooth(sma,2.5)"],
    ["smooth(ema,2,0)"],
    ["smooth(ema,2,1.1)"],
    ["smooth(asap,0)"],
    ["smooth(asap,2,0.5)"],
    ["fill(missing)"],
  ])("rejects invalid operation pipeline %j", (...operations) => {
    expect(
      TimeSeriesConfigSchema.safeParse({
        axes: [{ yAxis: "count()", transformations: operations }],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown chart shape properties instead of discarding them", () => {
    expect(
      TimeSeriesConfigSchema.safeParse({
        axes: [{ yAxis: "count()" }],
        groupBy: ["span.op"],
      }).success,
    ).toBe(false);
    expect(
      TimeSeriesConfigSchema.safeParse({ axes: [], interval: "0m" }).success,
    ).toBe(false);
  });
});
