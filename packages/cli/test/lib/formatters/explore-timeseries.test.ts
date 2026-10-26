import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type ExploreTimeSeriesData,
  formatExploreTimeSeriesHuman,
} from "../../../src/lib/formatters/explore-timeseries.js";

/** Sanitized shape of a captured spans timeseries response, including ingestion metadata. */
function makeData(): ExploreTimeSeriesData {
  return {
    org: "test-org",
    project: "test-project",
    dataset: "spans",
    meta: {
      dataset: "spans",
      start: Date.UTC(2026, 0, 1) + 123,
      end: Date.UTC(2026, 0, 1, 0, 15) + 456,
      ingestion: {
        status: "healthy",
        delaySeconds: 288,
        completeThrough: Date.UTC(2026, 0, 1, 0, 10, 12),
      },
    },
    timeSeries: [
      {
        yAxis: "count()",
        meta: {
          valueType: "integer",
          valueUnit: null,
          interval: 300_000,
          dataScanned: "full",
        },
        values: [
          {
            timestamp: Date.UTC(2026, 0, 1),
            value: 1234,
            incomplete: false,
            sampleCount: 1234,
            sampleRate: 1,
            confidence: "high",
          },
          {
            timestamp: Date.UTC(2026, 0, 1, 0, 5),
            value: 0,
            incomplete: false,
            sampleCount: 0,
            sampleRate: 1,
            confidence: "high",
          },
          {
            timestamp: Date.UTC(2026, 0, 1, 0, 10),
            value: 52,
            incomplete: true,
            incompleteReason: "INGESTION_PENDING",
            sampleCount: 52,
            sampleRate: 1,
            confidence: "high",
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.stubEnv("SENTRY_PLAIN_OUTPUT", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formatExploreTimeSeriesHuman", () => {
  test("renders UTC buckets, the effective interval, and ingestion completeness", () => {
    const output = formatExploreTimeSeriesHuman(makeData());

    expect(output).toContain("Querying spans in test-org/test-project");
    expect(output).toContain(
      "Range (UTC): 2026-01-01 00:00:00 to 2026-01-01 00:15:00",
    );
    expect(output).toContain("count() over time");
    expect(output).toContain("Interval: 5m");
    expect(output).toContain("TIME (UTC)");
    expect(output).toContain("1,234");
    expect(output).toMatch(/2026-01-01 00:05:00\s+│\s+0/);
    expect(output).toContain("Ingestion pending");
    expect(output).toContain("Ingestion status: healthy");
    expect(output).toContain("Reported ingestion delay: 4m 48s");
  });

  test("renders each measure with its own metadata and distinguishes missing values from zero", () => {
    const data = makeData();
    data.timeSeries[0]!.values.pop();
    data.timeSeries.push({
      yAxis: "p95(span.duration)",
      meta: {
        valueType: "duration",
        valueUnit: "millisecond",
        interval: 600_000,
      },
      values: [
        { timestamp: Date.UTC(2026, 0, 1), value: null, incomplete: false },
        {
          timestamp: Date.UTC(2026, 0, 1, 0, 10),
          value: 12.5,
          incomplete: false,
        },
      ],
    });

    const output = formatExploreTimeSeriesHuman(data);

    expect(output).toContain("count() over time");
    expect(output).toContain("p95(span.duration) over time");
    expect(output).toContain("Interval: 5m");
    expect(output).toContain("Interval: 10m");
    expect(output).toContain("Unit: millisecond");
    expect(output).toContain("12.5ms");
    expect(output).toMatch(/2026-01-01 00:05:00\s+│\s+0/);
    expect(output).toMatch(/2026-01-01 00:00:00\s+│\s+—/);
    expect(output).not.toContain("STATUS");
    expect(output).not.toContain("Ingestion status");
  });

  test("preserves identifier-like and markdown-like strings without coercion", () => {
    const data = makeData();
    const series = data.timeSeries[0]!;
    series.yAxis = "latest_event()";
    series.meta.valueType = "string";
    series.values = [
      { timestamp: Date.UTC(2026, 0, 1), value: "00123", incomplete: false },
      {
        timestamp: Date.UTC(2026, 0, 1, 0, 5),
        value: "*literal_value*",
        incomplete: false,
      },
      {
        timestamp: Date.UTC(2026, 0, 1, 0, 10),
        value: null,
        incomplete: false,
      },
    ];

    const output = formatExploreTimeSeriesHuman(data);

    expect(output).toContain("latest_event() over time");
    expect(output).toContain("00123");
    expect(output).toContain("*literal_value*");
    expect(output).toMatch(/2026-01-01 00:10:00\s+│\s+—/);
  });

  test("distinguishes retention, unfinished windows, and unavailable scan coverage", () => {
    const data = makeData();
    const series = data.timeSeries[0]!;
    series.meta.dataScanned = "partial";
    series.values[0] = {
      timestamp: Date.UTC(2026, 0, 1),
      value: 100,
      incomplete: true,
      incompleteReason: "OUTSIDE_RETENTION",
      sampleCount: 10,
      sampleRate: 0.1,
      confidence: "low",
    };
    series.values[2]!.incompleteReason = "NOT_ELAPSED";

    const output = formatExploreTimeSeriesHuman(data);

    expect(output).toContain("Outside retention");
    expect(output).toContain("Window not elapsed");
    expect(output).toContain("Only part of the available data was scanned");
    expect(output).toContain("Some buckets have low confidence");
    expect(output).toContain("Results include sampled data");
    expect(output).not.toContain("Ingestion pending");
    expect(output).not.toContain("Reported ingestion delay");
  });

  test("does not mistake absent series or buckets for zero-valued results", () => {
    const data = makeData();
    data.timeSeries[0]!.values = [];
    expect(formatExploreTimeSeriesHuman(data)).toContain(
      "No time buckets returned",
    );

    data.timeSeries = [];
    expect(formatExploreTimeSeriesHuman(data)).toContain(
      "No time series returned",
    );
  });
});
