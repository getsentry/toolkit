/**
 * Interval selection for Explore time series, using the granularities supported
 * by Sentry's spans, logs, and metrics datasets.
 */

import { parseFunction } from "@sentry/toolkit-core/events-fields";
import { ValidationError } from "./errors.js";
import { type TimeRangeApiParams, timeRangeToSeconds } from "./time-range.js";

/** Supported intervals in increasing duration order, with durations in seconds. */
const INTERVAL_SECONDS = {
  "15s": 15,
  "30s": 30,
  "1m": 60,
  "2m": 120,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "3h": 10_800,
  "4h": 14_400,
  "6h": 21_600,
  "12h": 43_200,
  "1d": 86_400,
} as const;

/** Explore UI's minimum interval ladder, in descending range duration. */
const DEFAULT_INTERVALS: readonly [number, keyof typeof INTERVAL_SECONDS][] = [
  [30 * 86_400, "3h"],
  [14 * 86_400, "1h"],
  [4 * 86_400, "30m"],
  [48 * 3600, "10m"],
  [12 * 3600, "5m"],
  [60, "1m"],
  [30, "30s"],
  [15, "15s"],
];

/** Sentry's ungrouped timeseries query budget; includes boundary buckets. */
const MAX_BUCKETS = 10_100;

/** Ordered transformation expressions keyed by zero-based request axis position. */
export type TimeSeriesTransformations = Readonly<
  Record<number, readonly string[]>
>;

/** Parse CLI and SDK axis:stage inputs without merging duplicate aggregate axes. */
export function parseTimeSeriesTransformations(
  values: readonly string[] | undefined,
  axisCount: number,
): TimeSeriesTransformations | undefined {
  if (!values?.length) {
    return;
  }
  const transformations: Record<number, string[]> = {};
  for (const value of values) {
    const separator = value.indexOf(":");
    const axis = value.slice(0, separator);
    const stage = value.slice(separator + 1).trim();
    const index = Number(axis);
    if (
      separator < 1 ||
      !/^(0|[1-9]\d*)$/.test(axis) ||
      !Number.isSafeInteger(index) ||
      index >= axisCount
    ) {
      throw new ValidationError(
        `Invalid transformation axis in "${value}". Use a zero-based --field position from 0 to ${axisCount - 1}, followed by a colon and a stage.`,
        "transform",
      );
    }
    const parsed = parseFunction(stage);
    if (!parsed || (parsed.name !== "fill" && parsed.name !== "smooth")) {
      throw new ValidationError(
        `Invalid transformation "${stage}". Use fill(mode) or smooth(mode,...), such as fill(linear) or smooth(sma,3).`,
        "transform",
      );
    }
    const axisTransformations = (transformations[index] ??= []);
    if (
      axisTransformations.some(
        (existing) => parseFunction(existing)?.name === parsed.name,
      )
    ) {
      throw new ValidationError(
        `Axis ${index} allows only one ${parsed.name} stage. Each axis may have one fill and one smooth transformation in either order.`,
        "transform",
      );
    }
    axisTransformations.push(stage);
  }
  return transformations;
}

/** Validate an explicit bucket duration without silently changing it. */
export function parseTimeSeriesInterval(
  value: string,
): keyof typeof INTERVAL_SECONDS {
  if (!Object.hasOwn(INTERVAL_SECONDS, value)) {
    throw new ValidationError(
      `Invalid interval "${value}". Use auto or one of: ${Object.keys(INTERVAL_SECONDS).join(", ")}.`,
      "time-series",
    );
  }
  return value as keyof typeof INTERVAL_SECONDS;
}

/**
 * Select a valid interval for a resolved API time range. The caller uses
 * timeRangeToApiParams first so open-ended periods have the same boundaries
 * for interval selection and the actual request.
 */
export function resolveTimeSeriesInterval(
  params: TimeRangeApiParams,
  interval?: string,
): string {
  const seconds = timeRangeToSeconds(
    params.statsPeriod
      ? { type: "relative", period: params.statsPeriod }
      : { type: "absolute", start: params.start, end: params.end },
  );
  if (seconds === undefined || seconds < 15) {
    throw new ValidationError(
      "Time series require a time range of at least 15 seconds. Use --period with a positive duration or date range.",
      "period",
    );
  }

  const defaultInterval =
    DEFAULT_INTERVALS.find(([minimum]) => seconds >= minimum)?.[1] ?? "15s";
  const selected =
    interval ??
    Object.entries(INTERVAL_SECONDS).find(
      ([, duration]) =>
        duration >= INTERVAL_SECONDS[defaultInterval] &&
        Math.ceil(seconds / duration) <= MAX_BUCKETS,
    )?.[0] ??
    "1d";
  const intervalSeconds = INTERVAL_SECONDS[parseTimeSeriesInterval(selected)];
  if (intervalSeconds > seconds) {
    throw new ValidationError(
      `Interval ${selected} is longer than the requested period. Use a smaller --time-series interval or a wider --period.`,
      "time-series",
    );
  }
  if (Math.ceil(seconds / intervalSeconds) > MAX_BUCKETS) {
    throw new ValidationError(
      `Interval ${selected} produces too many time buckets. Use a larger --time-series interval or a shorter --period.`,
      "time-series",
    );
  }
  return selected;
}
