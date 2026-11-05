import { describe, expect, it } from "vitest";
import type { EventsTimeSeriesResponse } from "../../../api-client/schema";
import {
  buildTimeSeriesResult,
  validateTimeSeriesResponse,
} from "./time-series-results";

const configuration = {
  axes: [
    { yAxis: "count()", transformations: ["fill(locf)", "smooth(sma,2)"] },
    { yAxis: "count()", transformations: ["smooth(ema,2)", "fill(zero)"] },
  ],
  interval: "1h",
};

function makeSeries(): EventsTimeSeriesResponse {
  return {
    timeSeries: configuration.axes.map(({ yAxis }) => ({
      yAxis,
      meta: { interval: 3600000 },
      values: [
        {
          timestamp: 1757548800000,
          value: 0,
          incomplete: false,
          filled: false,
          smoothed: false,
        },
      ],
    })),
  };
}

describe("buildTimeSeriesResult", () => {
  it("does not replace a missing value with zero when finding a raw peak", () => {
    const result = buildTimeSeriesResult({
      series: {
        timeSeries: [
          {
            yAxis: "sum(value)",
            meta: { interval: 60000, valueType: "number" },
            values: [
              { timestamp: 1, value: null, incomplete: false },
              { timestamp: 2, value: -4, incomplete: false },
            ],
          },
        ],
      },
      configuration: { axes: [{ yAxis: "sum(value)" }] },
      dataset: "metrics",
      query: "metric.name:balance metric.type:gauge",
      inputQuery: "balance",
      timeRange: { statsPeriod: "1h" },
      url: "https://example.sentry.io/explore/metrics/",
    });

    expect(result.series[0]).toMatchObject({
      summary: { peak: { value: -4, timestamp: 2 } },
      buckets: [
        { timestamp: 1, value: null, incomplete: false },
        { timestamp: 2, value: -4, incomplete: false },
      ],
    });
    expect(result.series[0]?.summary).not.toHaveProperty("total");
  });
});

describe("validateTimeSeriesResponse", () => {
  it("rejects empty transformed results but accepts an empty raw search", () => {
    expect(() =>
      validateTimeSeriesResponse({ timeSeries: [] }, configuration),
    ).toThrow("Empty transformed results cannot verify execution");
    expect(
      buildTimeSeriesResult({
        series: { timeSeries: [] },
        configuration: { axes: [{ yAxis: "count()" }] },
        dataset: "logs",
        query: "severity:error",
        inputQuery: "severity:error",
        timeRange: { statsPeriod: "1h" },
        url: "https://example.sentry.io/explore/logs/",
      }),
    ).toMatchObject({ requestedInterval: null, series: [] });
  });

  it("rejects grouped or reordered output instead of discarding series", () => {
    const grouped = makeSeries();
    grouped.timeSeries[0]!.groupBy = [
      { key: "environment", value: "production" },
    ];
    expect(() => validateTimeSeriesResponse(grouped, configuration)).toThrow(
      "Expected one ungrouped series per requested axis",
    );
    const reordered = makeSeries();
    reordered.timeSeries[0]!.yAxis = "avg(span.duration)";
    expect(() => validateTimeSeriesResponse(reordered, configuration)).toThrow(
      "in the same order",
    );
  });
});
