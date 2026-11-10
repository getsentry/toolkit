import type { EventsTimeSeriesResponse } from "../../../api-client/schema";
import { UserInputError } from "../../../errors";
import type { TimeSeriesConfig } from "../../../utils/time-series";

const UNVERIFIED_TRANSFORMATIONS =
  "Sentry did not confirm that the requested transformations ran. Enable Explore interpolation and smoothing for this organization and use a deployment that returns transformation flags. Empty transformed results cannot verify execution. Retry with a time range containing data, or explicitly remove the transformations for raw results.";

const UNSUPPORTED_SERIES_SHAPE =
  "Sentry returned an unsupported time-series shape. Expected one ungrouped series per requested axis, in the same order. Remove grouping and retry.";

export function validateTimeSeriesResponse(
  response: EventsTimeSeriesResponse,
  configuration: TimeSeriesConfig,
): void {
  const hasTransformations = configuration.axes.some(
    (axis) => (axis.transformations?.length ?? 0) > 0,
  );
  if (response.timeSeries.length === 0) {
    if (hasTransformations) {
      throw new UserInputError(UNVERIFIED_TRANSFORMATIONS);
    }
    return;
  }
  if (response.timeSeries.length !== configuration.axes.length) {
    throw new UserInputError(UNSUPPORTED_SERIES_SHAPE);
  }
  for (const [index, axis] of configuration.axes.entries()) {
    const series = response.timeSeries[index];
    if (
      !series ||
      series.yAxis !== axis.yAxis ||
      series.meta.isOther === true ||
      (Array.isArray(series.groupBy) && series.groupBy.length > 0)
    ) {
      throw new UserInputError(UNSUPPORTED_SERIES_SHAPE);
    }
    if ((axis.transformations?.length ?? 0) === 0) {
      continue;
    }
    if (
      series.values.length === 0 ||
      series.values.some(
        (bucket) =>
          typeof bucket.filled !== "boolean" ||
          typeof bucket.smoothed !== "boolean" ||
          (bucket.comparisonValue !== undefined &&
            (typeof bucket.comparisonFilled !== "boolean" ||
              typeof bucket.comparisonSmoothed !== "boolean")),
      )
    ) {
      throw new UserInputError(UNVERIFIED_TRANSFORMATIONS);
    }
  }
}

function isAdditiveTimeSeriesAggregate(yAxis: string): boolean {
  const aggregate = yAxis.trim().toLowerCase();
  return aggregate === "count()" || aggregate.startsWith("sum(");
}

function summarizeSeries(
  series: EventsTimeSeriesResponse["timeSeries"][number],
  transformed: boolean,
) {
  let total = 0;
  let allNumeric = series.meta.valueType !== "string";
  let maximum: { value: number | string; timestamp: number } | undefined;
  let maximumValue = Number.NEGATIVE_INFINITY;
  for (const bucket of series.values) {
    if (
      bucket.value == null ||
      series.meta.valueType === "string" ||
      (series.meta.valueType === "date" && bucket.value === 0)
    ) {
      allNumeric = false;
      continue;
    }
    const numeric = Number(bucket.value);
    if (Number.isFinite(numeric)) {
      total += numeric;
    } else {
      allNumeric = false;
    }
    const comparable = Number.isFinite(numeric)
      ? numeric
      : Date.parse(String(bucket.value));
    const filling =
      bucket.incomplete && bucket.incompleteReason !== "OUTSIDE_RETENTION";
    if (!filling && Number.isFinite(comparable) && comparable > maximumValue) {
      maximumValue = comparable;
      maximum = { value: bucket.value, timestamp: bucket.timestamp };
    }
  }
  return {
    ...(!transformed &&
    allNumeric &&
    series.values.length > 0 &&
    isAdditiveTimeSeriesAggregate(series.yAxis)
      ? { total }
      : {}),
    ...(maximum
      ? transformed
        ? { derivedMaximum: maximum }
        : { peak: maximum }
      : {}),
  };
}

export function buildTimeSeriesResult(params: {
  series: EventsTimeSeriesResponse;
  configuration: TimeSeriesConfig;
  dataset: string;
  query: string;
  inputQuery: string;
  timeRange: { statsPeriod?: string; start?: string; end?: string };
  url: string;
  explanation?: string;
  notes?: string[];
}) {
  const { series, configuration } = params;
  validateTimeSeriesResponse(series, configuration);
  return {
    dataset: params.dataset,
    query: params.query,
    inputQuery: params.inputQuery,
    timeRange: params.timeRange,
    requestedInterval: configuration.interval ?? null,
    url: params.url,
    ...(params.explanation ? { explanation: params.explanation } : {}),
    ...(params.notes?.length ? { notes: params.notes } : {}),
    series: series.timeSeries.map((axis, axisIndex) => {
      const summary = summarizeSeries(
        axis,
        (configuration.axes[axisIndex]?.transformations?.length ?? 0) > 0,
      );
      return {
        axisIndex,
        yAxis: axis.yAxis,
        transformations: configuration.axes[axisIndex]?.transformations ?? [],
        intervalMs: axis.meta.interval,
        ...(axis.meta.valueType !== undefined
          ? { valueType: axis.meta.valueType }
          : {}),
        ...(axis.meta.valueUnit !== undefined
          ? { valueUnit: axis.meta.valueUnit }
          : {}),
        ...(Object.keys(summary).length > 0 ? { summary } : {}),
        buckets: axis.values.map((bucket) => ({
          timestamp: bucket.timestamp,
          value: bucket.value ?? null,
          incomplete: bucket.incomplete,
          ...(bucket.incompleteReason !== undefined
            ? { incompleteReason: bucket.incompleteReason }
            : {}),
          ...(bucket.comparisonValue !== undefined
            ? { comparisonValue: bucket.comparisonValue }
            : {}),
          ...(bucket.filled !== undefined ||
          bucket.smoothed !== undefined ||
          bucket.comparisonFilled !== undefined ||
          bucket.comparisonSmoothed !== undefined
            ? {
                transformation: {
                  ...(bucket.filled !== undefined
                    ? { filled: bucket.filled }
                    : {}),
                  ...(bucket.smoothed !== undefined
                    ? { smoothed: bucket.smoothed }
                    : {}),
                  ...(bucket.comparisonFilled !== undefined
                    ? { comparisonFilled: bucket.comparisonFilled }
                    : {}),
                  ...(bucket.comparisonSmoothed !== undefined
                    ? { comparisonSmoothed: bucket.comparisonSmoothed }
                    : {}),
                },
              }
            : {}),
        })),
      };
    }),
  };
}
