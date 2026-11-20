import { describe, expect, it } from "vitest";
import { renderSentryChartOutputSchema } from "../src/tools/support/chart/schema";
import { parseChartResult } from "./parse";

const chart = {
  title: "count() of level:error",
  dataset: "errors",
  query: "level:error",
  yAxis: "count()",
  groupBy: "release",
  valueType: "integer",
  valueUnit: null,
  interval: "1h",
  timeRange: { statsPeriod: "24h", start: null, end: null },
  url: "https://sentry-mcp-evals.sentry.io/explore/discover/homepage/",
  series: [
    {
      label: "1.0.0",
      total: 12,
      buckets: [
        {
          time: "2025-09-10T23:00:00.000Z",
          value: 12,
          incomplete: false,
          outsideRetention: false,
        },
      ],
    },
    { label: "1.0.1", total: null, buckets: [] },
  ],
  peak: { series: "1.0.0", time: "2025-09-10T23:00:00.000Z", value: 12 },
  ingestion: {
    status: "healthy",
    delaySeconds: null,
    completeThrough: "2025-09-10T23:30:00.000Z",
  },
};

type Mutation = [string, (value: typeof chart) => unknown];

const invalid: Mutation[] = [
  ["null", () => null],
  ["an array", () => [chart]],
  ["no title", ({ title: _, ...rest }) => rest],
  ["a numeric query", (c) => ({ ...c, query: 1 })],
  ["an undefined groupBy", (c) => ({ ...c, groupBy: undefined })],
  ["no timeRange", (c) => ({ ...c, timeRange: null })],
  ["a series object", (c) => ({ ...c, series: {} })],
  [
    "a string bucket value",
    (c) => ({
      ...c,
      series: [
        {
          ...c.series[0],
          buckets: [{ ...c.series[0]?.buckets[0], value: "12" }],
        },
      ],
    }),
  ],
  [
    "a bucket without incomplete",
    (c) => ({
      ...c,
      series: [{ ...c.series[0], buckets: [{ time: "t", value: 1 }] }],
    }),
  ],
  ["a peak without time", (c) => ({ ...c, peak: { series: "a", value: 1 } })],
  ["no ingestion", ({ ingestion: _, ...rest }) => rest],
  [
    "a string delaySeconds",
    (c) => ({ ...c, ingestion: { ...c.ingestion, delaySeconds: "5" } }),
  ],
];

describe("parseChartResult", () => {
  it("returns what renderSentryChartOutputSchema returns for a valid result", () => {
    const input = { ...chart, extra: "dropped", peak: { ...chart.peak } };

    expect(parseChartResult(input)).toEqual(
      renderSentryChartOutputSchema.parse(input),
    );
    expect(parseChartResult(input)).not.toHaveProperty("extra");
  });

  it("accepts null peak and ingestion", () => {
    expect(parseChartResult({ ...chart, peak: null, ingestion: null })).toEqual(
      { ...chart, peak: null, ingestion: null },
    );
  });

  it.each(invalid)("rejects %s, as the schema does", (_, mutate) => {
    const input = mutate(structuredClone(chart));

    expect(renderSentryChartOutputSchema.safeParse(input).success).toBe(false);
    expect(parseChartResult(input)).toBeNull();
  });
});
