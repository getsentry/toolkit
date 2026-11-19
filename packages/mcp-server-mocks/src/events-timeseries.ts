/**
 * Deterministic `events-timeseries` responses. The series ends at a fixed
 * time and its bucket size follows the requested range, so a chart drawn
 * from it looks the same on every run and changes shape when the range does.
 */
import { HttpResponse } from "msw";

const SERIES_END = Date.UTC(2025, 8, 11, 0, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Bucket size per range when the request names no interval. */
const DEFAULT_INTERVALS: [rangeMs: number, intervalMs: number][] = [
  [HOUR, MINUTE],
  [DAY, 30 * MINUTE],
  [7 * DAY, 3 * HOUR],
  [Number.POSITIVE_INFINITY, 6 * HOUR],
];

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: MINUTE,
  h: HOUR,
  d: DAY,
  w: 7 * DAY,
};

function parseDuration(value: string | null): number | undefined {
  const match = value ? /^(\d+)([smhdw])$/.exec(value) : null;
  const unit = match?.[2];
  return match && unit ? Number(match[1]) * (UNIT_MS[unit] ?? 0) : undefined;
}

const GROUP_VALUES = ["frontend@2.4.1", "frontend@2.4.0", "frontend@2.3.9"];

export function eventsTimeSeriesResponse(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const yAxis = params.get("yAxis");
  if (!params.get("dataset") || !yAxis) {
    return HttpResponse.json(
      { detail: "dataset and yAxis are required" },
      { status: 400 },
    );
  }
  const topEvents = params.get("topEvents");
  const groupBy = params.get("groupBy");
  if (topEvents && (!groupBy || !params.get("sort"))) {
    return HttpResponse.json(
      { detail: "groupBy is a required parameter when doing topEvents" },
      { status: 400 },
    );
  }

  const start = params.get("start");
  const end = params.get("end");
  const [rangeStart, rangeEnd] =
    start && end
      ? [Date.parse(start), Date.parse(end)]
      : [
          SERIES_END - (parseDuration(params.get("statsPeriod")) ?? 14 * DAY),
          SERIES_END,
        ];
  const range = rangeEnd - rangeStart;
  const interval =
    parseDuration(params.get("interval")) ??
    DEFAULT_INTERVALS.find(([limit]) => range <= limit)?.[1] ??
    6 * HOUR;
  const bucketCount = Math.max(1, Math.round(range / interval));

  const groups = groupBy
    ? GROUP_VALUES.slice(0, Number(topEvents) || GROUP_VALUES.length)
    : [null];
  const isDuration = /duration/.test(yAxis);
  const timeSeries = groups.map((group, groupIndex) => ({
    yAxis,
    ...(group !== null && { groupBy: [{ key: groupBy, value: group }] }),
    values: Array.from({ length: bucketCount }, (_, index) => {
      const wave = Math.sin((index / bucketCount) * Math.PI * 4 + groupIndex);
      const spike = index === Math.floor(bucketCount * 0.7) ? 2.5 : 1;
      const base = (isDuration ? 180 : 40) / (groupIndex + 1);
      const isLast = index === bucketCount - 1;
      return {
        timestamp: rangeEnd - (bucketCount - index) * interval,
        value: Math.round(base * (1.4 + wave) * spike),
        incomplete: isLast,
        ...(isLast && { incompleteReason: "INGESTION_PENDING" }),
      };
    }),
    meta: {
      interval,
      valueType: isDuration ? "duration" : "integer",
      valueUnit: isDuration ? "millisecond" : null,
      ...(group !== null && { order: groupIndex, isOther: false }),
    },
  }));

  return HttpResponse.json({
    timeSeries,
    meta: { start: rangeStart, end: rangeEnd },
  });
}
