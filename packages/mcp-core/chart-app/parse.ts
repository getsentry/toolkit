/**
 * Parses an untrusted chart tool's `structuredContent` into a
 * ChartResult, or returns null. Hand-written so the view ships without zod;
 * parse.test.ts keeps it in step with chartOutputSchema. Builds a
 * new object, so unknown fields never reach the view.
 */
import type { ChartResult } from "../src/tools/support/chart/schema";

type Series = ChartResult["series"][number];

/** Thrown inside the parser; parseChartResult turns it into null. */
class Invalid extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Invalid();
  }
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Invalid();
  return value;
}

function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Invalid();
  return value;
}

function nullable<T>(parse: (value: unknown) => T, value: unknown): T | null {
  return value === null ? null : parse(value);
}

function list<T>(parse: (value: unknown) => T, value: unknown): T[] {
  if (!Array.isArray(value)) throw new Invalid();
  return value.map(parse);
}

function index(value: unknown): number {
  const n = num(value);
  if (!Number.isInteger(n) || n < 0) throw new Invalid();
  return n;
}

function series(value: unknown): Series {
  const s = record(value);
  return {
    label: str(s["label"]),
    count: nullable(num, s["count"]),
    total: nullable(num, s["total"]),
    values: list((v) => nullable(num, v), s["values"]),
  };
}

function peak(value: unknown): NonNullable<ChartResult["peak"]> {
  const p = record(value);
  return {
    series: str(p["series"]),
    time: str(p["time"]),
    value: num(p["value"]),
  };
}

function ingestion(value: unknown): NonNullable<ChartResult["ingestion"]> {
  const i = record(value);
  return {
    status: str(i["status"]),
    delaySeconds: nullable(num, i["delaySeconds"]),
    completeThrough: nullable(str, i["completeThrough"]),
  };
}

/**
 * The tool the range picker calls again. Only a chart tool, so a result
 * cannot point the view at a tool that changes data. Results from before the
 * field existed came from render_sentry_chart.
 */
function chartTool(value: unknown): ChartResult["tool"] {
  if (value === undefined) return "render_sentry_chart";
  if (value !== "render_sentry_chart" && value !== "render_issue_chart") {
    throw new Invalid();
  }
  return value;
}

export function parseChartResult(value: unknown): ChartResult | null {
  try {
    const c = record(value);
    const range = record(c["timeRange"]);
    return {
      tool: chartTool(c["tool"]),
      title: str(c["title"]),
      dataset: str(c["dataset"]),
      query: str(c["query"]),
      yAxis: str(c["yAxis"]),
      groupBy: nullable(str, c["groupBy"]),
      valueType: nullable(str, c["valueType"]),
      valueUnit: nullable(str, c["valueUnit"]),
      interval: str(c["interval"]),
      timeRange: {
        statsPeriod: nullable(str, range["statsPeriod"]),
        start: nullable(str, range["start"]),
        end: nullable(str, range["end"]),
      },
      url: str(c["url"]),
      times: list(str, c["times"]),
      incomplete: list(index, c["incomplete"]),
      outsideRetention: list(index, c["outsideRetention"]),
      series: list(series, c["series"]),
      peak: nullable(peak, c["peak"]),
      ingestion: nullable(ingestion, c["ingestion"]),
    };
  } catch (error) {
    if (error instanceof Invalid) return null;
    throw error;
  }
}
