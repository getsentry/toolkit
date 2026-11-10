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
  it.each([false, true])(
    "includes final retention buckets in the maximum (transformed: %s)",
    (transformed) => {
      const result = buildTimeSeriesResult({
        series: {
          timeSeries: [
            {
              yAxis: "count()",
              meta: { interval: 60000, valueType: "number" },
              values: [
                { timestamp: 1, value: 8, incomplete: false },
                {
                  timestamp: 2,
                  value: 12,
                  incomplete: true,
                  incompleteReason: "OUTSIDE_RETENTION",
                },
                {
                  timestamp: 3,
                  value: 20,
                  incomplete: true,
                  incompleteReason: "INGESTION_PENDING",
                },
                {
                  timestamp: 4,
                  value: 30,
                  incomplete: true,
                  incompleteReason: "NOT_ELAPSED",
                },
              ].map((bucket) => ({
                ...bucket,
                filled: false,
                smoothed: false,
              })),
            },
          ],
        },
        configuration: {
          axes: [
            {
              yAxis: "count()",
              transformations: transformed ? ["smooth(sma,2)"] : [],
            },
          ],
        },
        dataset: "spans",
        query: "",
        inputQuery: "requests",
        timeRange: { statsPeriod: "1h" },
        url: "https://example.sentry.io/explore/traces/",
      });

      expect(result.series[0]?.summary).toHaveProperty(
        transformed ? "derivedMaximum" : "peak",
        { value: 12, timestamp: 2 },
      );
    },
  );

  it.each([false, true])(
    "omits a date maximum when only empty buckets are final (transformed: %s)",
    (transformed) => {
      const result = buildTimeSeriesResult({
        series: {
          timeSeries: [
            {
              yAxis: "max(timestamp)",
              meta: { interval: 60000, valueType: "date" },
              values: [
                { timestamp: 1, value: 0, incomplete: false },
                {
                  timestamp: 2,
                  value: "2026-11-05T10:30:00Z",
                  incomplete: true,
                  incompleteReason: "INGESTION_PENDING",
                },
              ].map((bucket) => ({
                ...bucket,
                filled: false,
                smoothed: false,
              })),
            },
          ],
        },
        configuration: {
          axes: [
            {
              yAxis: "max(timestamp)",
              transformations: transformed ? ["smooth(sma,2)"] : [],
            },
          ],
        },
        dataset: "logs",
        query: "severity:error",
        inputQuery: "latest error over time",
        timeRange: { statsPeriod: "1h" },
        url: "https://example.sentry.io/explore/logs/",
      });

      expect(result.series[0]?.summary).toBeUndefined();
    },
  );

  it("orders ISO date values by time and preserves the original peak value", () => {
    const result = buildTimeSeriesResult({
      series: {
        timeSeries: [
          {
            yAxis: "max(timestamp)",
            meta: { interval: 60000, valueType: "date" },
            values: [
              { timestamp: 1, value: 0, incomplete: false },
              {
                timestamp: 2,
                value: "2026-11-05T10:30:00Z",
                incomplete: false,
              },
              {
                timestamp: 3,
                value: "2026-11-05T10:00:00-01:00",
                incomplete: false,
              },
              { timestamp: 4, value: "2026-11-05T11:30:00Z", incomplete: true },
            ],
          },
        ],
      },
      configuration: { axes: [{ yAxis: "max(timestamp)" }] },
      dataset: "logs",
      query: "severity:error",
      inputQuery: "latest error over time",
      timeRange: { statsPeriod: "1h" },
      url: "https://example.sentry.io/explore/logs/",
    });

    expect(result.series[0]?.summary).toEqual({
      peak: { value: "2026-11-05T10:00:00-01:00", timestamp: 3 },
    });
  });

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
