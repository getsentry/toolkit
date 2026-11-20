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

/**
 * Releases for grouped requests, busiest first. The first three carry steady
 * traffic. The rest have a handful of events each, every one at the 30s
 * pageload cap, so their p95 is the highest and almost every bucket is empty.
 * Ranking groups by p95 picks the sparse ones; ranking by count picks the
 * busy ones.
 */
interface Release {
  name: string;
  /** Events per bucket for a busy release; total events for a sparse one. */
  events: number;
  /** Typical duration in ms. */
  duration: number;
  /** Buckets with events, for a sparse release; busy ones fill every bucket. */
  hits?: number;
}

const sha = (seed: string) => seed.repeat(40).slice(0, 40);

const MOCK_RELEASES: Release[] = [
  { name: sha("3f9c2e1a"), events: 120, duration: 6200 },
  { name: sha("8b41d07c"), events: 60, duration: 6800 },
  { name: sha("c05e9a3f"), events: 20, duration: 7400 },
  { name: sha("1d7f4b2e"), events: 57, duration: 30_000, hits: 6 },
  { name: sha("e2a86c91"), events: 23, duration: 30_000, hits: 4 },
  { name: sha("94b3f5d0"), events: 7, duration: 30_000, hits: 3 },
  { name: sha("5a0e17b8"), events: 3, duration: 30_000, hits: 2 },
  { name: sha("f61c2d49"), events: 1, duration: 30_000, hits: 1 },
];

/** Events a release has in bucket `index` of `bucketCount`. */
function releaseEvents(
  release: Release,
  releaseIndex: number,
  index: number,
  bucketCount: number,
): number {
  if (release.hits === undefined) {
    const wave = Math.sin((index / bucketCount) * Math.PI * 4 + releaseIndex);
    return Math.round(release.events * (1 + 0.3 * wave));
  }
  const hits = Math.min(release.hits, bucketCount);
  for (let hit = 0; hit < hits; hit++) {
    const at = Math.floor(((hit + 0.5) / hits) * bucketCount + releaseIndex);
    if (at % bucketCount !== index) continue;
    const base = Math.floor(release.events / hits);
    return base + (hit < release.events % hits ? 1 : 0);
  }
  return 0;
}

const isCount = (yAxis: string) => yAxis.startsWith("count(");
const isDuration = (yAxis: string) => /duration/.test(yAxis);

/**
 * One release's bucket value: its event count for `count()`, otherwise a
 * duration-like value, or null for a bucket with no events, as Sentry
 * returns for percentiles and averages.
 */
function releaseValue(
  release: Release,
  releaseIndex: number,
  yAxis: string,
  index: number,
  bucketCount: number,
): number | null {
  const events = releaseEvents(release, releaseIndex, index, bucketCount);
  if (isCount(yAxis)) return events;
  if (events === 0) return null;
  if (release.hits !== undefined) return release.duration;
  // Unrounded, as Sentry returns percentiles.
  return release.duration * (1 + 0.12 * Math.sin(index / 3 + releaseIndex));
}

export function eventsTimeSeriesResponse(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const yAxes = params.getAll("yAxis");
  if (!params.get("dataset") || yAxes.length === 0) {
    return HttpResponse.json(
      { detail: "dataset and yAxis are required" },
      { status: 400 },
    );
  }
  const topEvents = params.get("topEvents");
  const groupBy = params.get("groupBy");
  const sort = params.get("sort");
  if (topEvents && (!groupBy || !sort)) {
    return HttpResponse.json(
      { detail: "groupBy is a required parameter when doing topEvents" },
      { status: 400 },
    );
  }
  const sortBy = sort?.replace(/^-/, "");
  if (topEvents && !yAxes.includes(sortBy ?? "")) {
    return HttpResponse.json(
      { detail: `Cannot sort by ${sortBy}: it is not a selected column` },
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
  const bucket = (index: number, value: number | null) => {
    const isLast = index === bucketCount - 1;
    return {
      timestamp: rangeEnd - (bucketCount - index) * interval,
      value,
      incomplete: isLast,
      ...(isLast && { incompleteReason: "INGESTION_PENDING" }),
    };
  };
  const meta = (yAxis: string) => ({
    interval,
    valueType: isDuration(yAxis) && !isCount(yAxis) ? "duration" : "integer",
    valueUnit: isDuration(yAxis) && !isCount(yAxis) ? "millisecond" : null,
  });

  if (!groupBy) {
    const timeSeries = yAxes.map((yAxis) => ({
      yAxis,
      values: Array.from({ length: bucketCount }, (_, index) => {
        const wave = Math.sin((index / bucketCount) * Math.PI * 4);
        const spike = index === Math.floor(bucketCount * 0.7) ? 2.5 : 1;
        const base = isDuration(yAxis) ? 180 : 40;
        return bucket(index, Math.round(base * (1.4 + wave) * spike));
      }),
      meta: meta(yAxis),
    }));
    return HttpResponse.json({
      timeSeries,
      meta: { start: rangeStart, end: rangeEnd },
    });
  }

  // Rank as Sentry does for `sort=-<aggregate>`: by total events for a
  // count, otherwise by the release's typical value.
  const rank = (release: Release, index: number) =>
    isCount(sortBy ?? "")
      ? Array.from({ length: bucketCount }, (_, i) =>
          releaseEvents(release, index, i, bucketCount),
        ).reduce((sum, events) => sum + events, 0)
      : release.duration;
  const ranked = MOCK_RELEASES.map((release, index) => ({
    release,
    index,
    rank: rank(release, index),
  }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, Number(topEvents) || MOCK_RELEASES.length);
  const timeSeries = ranked.flatMap(({ release, index: releaseIndex }, order) =>
    yAxes.map((yAxis) => ({
      yAxis,
      groupBy: [{ key: groupBy, value: release.name }],
      values: Array.from({ length: bucketCount }, (_, index) =>
        bucket(
          index,
          releaseValue(release, releaseIndex, yAxis, index, bucketCount),
        ),
      ),
      meta: { ...meta(yAxis), order, isOther: false },
    })),
  );

  return HttpResponse.json({
    timeSeries,
    meta: { start: rangeStart, end: rangeEnd },
  });
}
