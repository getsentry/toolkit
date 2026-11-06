import { z } from "zod";
import { UserInputError } from "../errors";

const positiveInteger = (value: string | undefined): boolean =>
  value !== undefined &&
  /^[1-9]\d*$/.test(value) &&
  Number.isSafeInteger(Number(value));

function isTransformation(value: string): boolean {
  if (/^fill\((?:zero|locf|linear)\)$/.test(value)) {
    return true;
  }
  const match = /^smooth\((sma|ema|asap)(?:,([^,()]+))?(?:,([^,()]+))?\)$/.exec(
    value,
  );
  if (!match) {
    return false;
  }
  const [, mode, window, factor] = match;
  if (mode === "asap") {
    return (
      factor === undefined && (window === undefined || positiveInteger(window))
    );
  }
  if (!positiveInteger(window)) {
    return false;
  }
  if (mode === "sma") {
    return factor === undefined;
  }
  return (
    factor === undefined ||
    (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(factor) &&
      Number(factor) > 0 &&
      Number(factor) <= 1)
  );
}

export const TransformationPipelineSchema = z
  .array(
    z
      .string()
      .trim()
      .describe(
        "Operation in execution order: fill(zero|locf|linear), smooth(sma,window), smooth(ema,window[,factor]), or smooth(asap[,maxWindow]).",
      )
      .refine(isTransformation, {
        message:
          "Use fill(zero|locf|linear), smooth(sma,window), smooth(ema,window[,factor]), or smooth(asap[,maxWindow]). Windows must be positive integers and EMA factor must be greater than zero and at most one.",
      }),
  )
  .max(2)
  .refine(
    (operations) =>
      new Set(operations.map((operation) => operation.split("(", 1)[0]))
        .size === operations.length,
    {
      message: "Use at most one fill and one smooth operation per axis.",
    },
  )
  .describe(
    "Ordered pipeline with at most one fill and one smooth operation. An empty array requests raw values.",
  );

export const TimeSeriesConfigSchema = z
  .object({
    axes: z
      .array(
        z
          .object({
            yAxis: z
              .string()
              .trim()
              .min(1)
              .regex(
                /^[\w]+\(.*\)$/,
                "Use an aggregate such as count() or avg(span.duration).",
              ),
            transformations: TransformationPipelineSchema.optional(),
          })
          .strict(),
      )
      .min(1),
    interval: z
      .string()
      .regex(
        /^[1-9]\d*[smhdw]$/,
        "Use a positive bucket interval such as 1m, 1h, or 1d.",
      )
      .nullable()
      .optional(),
  })
  .strict();

export type TimeSeriesConfig = z.infer<typeof TimeSeriesConfigSchema>;

const DURATION_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

const EXPLORE_INTERVAL_MINIMUMS = [
  [30 * 86400, 10800],
  [14 * 86400, 3600],
  [4 * 86400, 1800],
  [48 * 3600, 600],
  [12 * 3600, 300],
  [0, 60],
] as const;

function durationSeconds(value: string): number {
  const match = /^(\d+)([smhdw])$/.exec(value);
  return match ? Number(match[1]) * DURATION_SECONDS[match[2]!]! : Number.NaN;
}

export function getTimeSeriesExploreInterval(
  config: TimeSeriesConfig,
  executedIntervalMs: number | undefined,
  timeRange: { statsPeriod?: string; start?: string; end?: string },
): string | undefined {
  const interval =
    executedIntervalMs === undefined
      ? config.interval
      : config.interval &&
          durationSeconds(config.interval) === executedIntervalMs / 1000
        ? config.interval
        : `${executedIntervalMs / 1000}s`;
  if (!interval) {
    return undefined;
  }
  const rangeSeconds =
    timeRange.start && timeRange.end
      ? (Date.parse(timeRange.end) - Date.parse(timeRange.start)) / 1000
      : durationSeconds(timeRange.statsPeriod ?? "24h");
  // Explore's useChartInterval.tsx replaces intervals outside this range.
  const minimum =
    EXPLORE_INTERVAL_MINIMUMS.find(([range]) => rangeSeconds >= range)?.[1] ??
    60;
  const intervalSeconds = durationSeconds(interval);
  if (
    !Number.isFinite(rangeSeconds) ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds < minimum ||
    intervalSeconds > rangeSeconds
  ) {
    throw new UserInputError(
      `Explore cannot preserve this bucket interval for the requested time range. Use timeSeries.interval between ${minimum}s and ${rangeSeconds}s, or change period.`,
    );
  }
  return interval;
}

export function normalizeTimeSeriesConfig(
  value:
    | TimeSeriesConfig
    | { yAxis: string; transformations?: string[]; interval?: string | null },
): TimeSeriesConfig {
  if ("axes" in value) {
    return value;
  }
  return {
    axes: [{ yAxis: value.yAxis, transformations: value.transformations }],
    interval: value.interval,
  };
}

export function appendTimeSeriesParams(
  params: URLSearchParams,
  config: TimeSeriesConfig,
): void {
  for (const [index, axis] of config.axes.entries()) {
    params.append("yAxis", axis.yAxis);
    for (const operation of axis.transformations ?? []) {
      params.append(`transformations[${index}]`, operation);
    }
  }
  if (config.interval) {
    params.set("interval", config.interval);
  }
}

export function timeSeriesCharts(
  config: TimeSeriesConfig,
): Array<{ yAxes: string[]; transformations?: string[] }> {
  return config.axes.map((axis) => ({
    yAxes: [axis.yAxis],
    ...(axis.transformations === undefined
      ? {}
      : { transformations: axis.transformations }),
  }));
}
