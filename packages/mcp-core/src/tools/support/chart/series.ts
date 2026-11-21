/**
 * Turns an `events-timeseries` response into a ChartResult's time axis and
 * series. Shared by every tool that renders the chart view.
 */
import type { EventsTimeSeriesResponse } from "../../../api-client/schema";
import { UserInputError } from "../../../errors";
import { maskQuotedRegions } from "../search-events/utils";
import type { ChartResult } from "./schema";

export type TimeSeries = EventsTimeSeriesResponse["timeSeries"][number];

const INTERVAL_UNITS: [unit: string, ms: number][] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
];

/** A bucket size in ms as Sentry writes it, such as `4h` or `20m`. */
export function formatInterval(ms: number): string {
  for (const [unit, unitMs] of INTERVAL_UNITS) {
    if (ms % unitMs === 0) return `${ms / unitMs}${unit}`;
  }
  return `${ms / 1000}s`;
}

interface TimeRangeParams {
  period: string | null;
  start: string | null;
  end: string | null;
}

export type TimeRange = {
  statsPeriod?: string;
  start?: string;
  end?: string;
};

/** The request's time params: `start` and `end`, or a period. */
export function resolveTimeRange(
  params: TimeRangeParams,
  defaultPeriod: string,
): TimeRange {
  if ((params.start === null) !== (params.end === null)) {
    throw new UserInputError("Pass both `start` and `end`, or neither.");
  }
  if (params.start !== null && params.period !== null) {
    throw new UserInputError(
      "Pass either `period` or `start` and `end`, not both.",
    );
  }
  return params.start !== null && params.end !== null
    ? { start: params.start, end: params.end }
    : { statsPeriod: params.period ?? defaultPeriod };
}

export function timeRangeResult(range: TimeRange): ChartResult["timeRange"] {
  return {
    statsPeriod: range.statsPeriod ?? null,
    start: range.start ?? null,
    end: range.end ?? null,
  };
}

const isCount = (yAxis: string) => /^count\(/i.test(yAxis);
const isAdditive = (yAxis: string) => isCount(yAxis) || /^sum\(/i.test(yAxis);

/** A bucket value as a number, or null where the bucket has no data. */
function bucketValue(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  // Date-typed aggregates such as max(timestamp) return ISO datetime strings.
  const parsed = Number(raw);
  const value = Number.isNaN(parsed) ? Date.parse(String(raw)) : parsed;
  if (!Number.isFinite(value)) return null;
  // Drops float noise such as 6234.500000001 to keep the result compact.
  return Number.isInteger(value) ? value : Number(value.toPrecision(8));
}

/** Sum of every bucket of a series. */
export function seriesTotal(entry: TimeSeries): number {
  return entry.values.reduce<number>(
    (total, bucket) => total + (bucketValue(bucket.value) ?? 0),
    0,
  );
}

function indexesWhere<T>(items: readonly T[], test: (item: T) => boolean) {
  return items.flatMap((item, index) => (test(item) ? [index] : []));
}

export interface PlottedSeries {
  label: string;
  entry: TimeSeries;
  /** Events behind the series; defaults to the total of a count series. */
  count?: number | undefined;
}

/**
 * Builds one shared time axis and one value array per series, in the order
 * given. `peakSeries` names the series whose highest bucket is the chart's
 * peak; it defaults to the only series of a single-series chart. Across
 * groups, any one bucket would headline a single group, which reads as the
 * chart's peak.
 */
export function toChart(
  plotted: readonly PlottedSeries[],
  peakSeries: string | null = plotted.length === 1
    ? (plotted[0]?.label ?? null)
    : null,
): Pick<
  ChartResult,
  "times" | "incomplete" | "outsideRetention" | "series" | "peak"
> {
  const buckets = plotted[0]?.entry.values ?? [];
  const outsideRetention = (b: (typeof buckets)[number]) =>
    b.incomplete && b.incompleteReason === "OUTSIDE_RETENTION";
  const incomplete = indexesWhere(
    buckets,
    (b) => b.incomplete && !outsideRetention(b),
  );
  const series = plotted.map(({ label, entry, count }) => {
    const values = entry.values.map((b) => bucketValue(b.value));
    const total = isAdditive(entry.yAxis) ? seriesTotal(entry) : null;
    return {
      label,
      count: count ?? (isCount(entry.yAxis) ? total : null),
      total,
      values,
    };
  });

  let peak: ChartResult["peak"] = null;
  const peaked = series.find((entry) => entry.label === peakSeries);
  for (const [index, value] of (peaked?.values ?? []).entries()) {
    const bucket = buckets[index];
    if (!peaked || value === null || !bucket || incomplete.includes(index)) {
      continue;
    }
    if (!peak || value > peak.value) {
      peak = {
        series: peaked.label,
        time: new Date(bucket.timestamp).toISOString(),
        value,
      };
    }
  }

  return {
    times: buckets.map((b) => new Date(b.timestamp).toISOString()),
    incomplete,
    outsideRetention: indexesWhere(buckets, outsideRetention),
    series,
    peak,
  };
}

/**
 * True when a search query keeps only the events of named issues
 * (`issue:` or `issue.id:`, not negated, not inside a quoted value). The
 * errors dataset holds only error issues, so such a query returns all-zero
 * buckets for any other issue.
 */
export function filtersToIssues(query: string): boolean {
  return /(?:^|[\s(])issue(?:\.id)?:\S/i.test(maskQuotedRegions(query));
}
