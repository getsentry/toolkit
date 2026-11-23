import { describe, expect, it } from "vitest";
import { chartOutputSchema } from "../src/tools/support/chart/schema";
import { parseChartResult } from "./parse";

const chart = {
  tool: "render_sentry_chart",
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
  times: ["2025-09-10T23:00:00.000Z", "2025-09-11T00:00:00.000Z"],
  incomplete: [1],
  outsideRetention: [],
  series: [
    { label: "1.0.0", count: 12, total: 12, values: [12, 0] },
    { label: "1.0.1", count: null, total: null, values: [null, null] },
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
  ["no times", ({ times: _, ...rest }) => rest],
  [
    "a string value",
    (c) => ({ ...c, series: [{ ...c.series[0], values: ["12"] }] }),
  ],
  ["a fractional bucket index", (c) => ({ ...c, incomplete: [0.5] })],
  ["a negative bucket index", (c) => ({ ...c, outsideRetention: [-1] })],
  [
    "a series without count",
    (c) => ({ ...c, series: [{ label: "a", total: null, values: [] }] }),
  ],
  ["a peak without time", (c) => ({ ...c, peak: { series: "a", value: 1 } })],
  ["no ingestion", ({ ingestion: _, ...rest }) => rest],
  ["a tool that is not a chart tool", (c) => ({ ...c, tool: "update_issue" })],
  [
    "a string delaySeconds",
    (c) => ({ ...c, ingestion: { ...c.ingestion, delaySeconds: "5" } }),
  ],
];

describe("parseChartResult", () => {
  it("returns what chartOutputSchema returns for a valid result", () => {
    const input = { ...chart, extra: "dropped", peak: { ...chart.peak } };

    expect(parseChartResult(input)).toEqual(chartOutputSchema.parse(input));
    expect(parseChartResult(input)).not.toHaveProperty("extra");
  });

  it("accepts null peak and ingestion", () => {
    expect(parseChartResult({ ...chart, peak: null, ingestion: null })).toEqual(
      { ...chart, peak: null, ingestion: null },
    );
  });

  it("reads a result without a tool as render_sentry_chart's", () => {
    const { tool: _, ...rest } = chart;

    expect(parseChartResult(rest)?.tool).toBe("render_sentry_chart");
  });

  it.each(invalid)("rejects %s, as the schema does", (_, mutate) => {
    const input = mutate(structuredClone(chart));

    expect(chartOutputSchema.safeParse(input).success).toBe(false);
    expect(parseChartResult(input)).toBeNull();
  });
});
