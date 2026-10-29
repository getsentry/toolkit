/**
 * Human charts/tables and JSON output for Explore aggregates bucketed over time.
 * Keeps response metadata and bucket values intact for machine consumers.
 */

import type { EventsTimeSeriesResponse } from "../api/explore.js";
import { formatExploreTimeSeriesChart } from "./explore-timeseries-chart.js";
import { filterFields } from "./json.js";
import { escapeMarkdownInline, renderMarkdown } from "./markdown.js";
import { buildMetaColumns } from "./meta-table.js";
import { formatTable } from "./table.js";
import {
  formatDurationCompact,
  formatDurationCompactMs,
  formatUtcTimestamp,
} from "./time-utils.js";

/** An API response with the query scope used by human output. */
export type ExploreTimeSeriesData = EventsTimeSeriesResponse & {
  /** API dataset used for this query. */
  dataset: string;
  /** Organization slug, omitted from JSON output. */
  org: string;
  /** Optional project slug, omitted from JSON output. */
  project?: string;
};

type TimeSeries = EventsTimeSeriesResponse["timeSeries"][number];
type Bucket = TimeSeries["values"][number];

/** Explain why a bucket is incomplete without describing retained data as pending. */
function formatBucketStatus(bucket: Bucket): string {
  if (!bucket.incomplete) {
    return "";
  }
  switch (bucket.incompleteReason) {
    case "NOT_ELAPSED":
      return "Window not elapsed";
    case "INGESTION_PENDING":
      return "Ingestion pending";
    case "OUTSIDE_RETENTION":
      return "Outside retention";
    default:
      return "Incomplete";
  }
}

/** Render one measure, retaining metadata and exact values for graph gaps. */
function formatSeries(series: TimeSeries): string {
  const details = [
    `**${escapeMarkdownInline(series.yAxis)} over time**`,
    `Interval: ${formatDurationCompactMs(series.meta.interval)}`,
  ];
  if (series.meta.valueUnit && series.meta.valueUnit !== "none") {
    details.push(`Unit: ${escapeMarkdownInline(series.meta.valueUnit)}`);
  }

  if (series.meta.dataScanned === "partial") {
    details.push("Only part of the available data was scanned.");
  }
  if (series.values.some((bucket) => bucket.confidence === "low")) {
    details.push(
      "Some buckets have low confidence; treat their values as estimates.",
    );
  }
  if (
    series.values.some(
      (bucket) => bucket.sampleRate != null && bucket.sampleRate < 1,
    )
  ) {
    details.push("Results include sampled data.");
  }

  const header = renderMarkdown(details.join("\n\n"));
  if (series.values.length === 0) {
    return `${header}\n\nNo time buckets returned.`;
  }

  const chart = formatExploreTimeSeriesChart(series);
  if (!chart) {
    return `${header}\n\n${formatBuckets(series, series.values)}`;
  }
  const gaps = series.values.filter(
    (bucket) => bucket.value === null || bucket.incomplete,
  );
  const gapDetails =
    gaps.length > 0
      ? `\n\n${renderMarkdown("Gaps are missing or incomplete buckets, listed below. Complete buckets have at least a baseline tick, including zeros.")}\n\n${formatBuckets(series, gaps)}`
      : "";
  return `${header}\n\n${chart}${gapDetails}`;
}

/** Use the same typed cells for the full fallback and the chart's gap details. */
function formatBuckets(series: TimeSeries, buckets: Bucket[]): string {
  const rows = buckets.map((bucket) => ({
    time: formatUtcTimestamp(bucket.timestamp),
    value: bucket.value,
    status: formatBucketStatus(bucket),
  }));
  const columns = buildMetaColumns(
    ["time", "value"],
    { value: series.meta.valueType },
    { value: series.meta.valueUnit },
  ).map((column, index) =>
    index === 0
      ? { ...column, header: "TIME (UTC)", shrinkable: false }
      : {
          ...column,
          value: (row: Record<string, unknown>) =>
            typeof row.value === "string"
              ? escapeMarkdownInline(row.value.replace(/\n/g, " "))
              : column.value(row),
        },
  );
  if (buckets.some((bucket) => bucket.incomplete)) {
    columns.push(...buildMetaColumns(["status"]));
  }

  return formatTable(rows, columns);
}

/**
 * Render temporal buckets in UTC, with a table fallback for terminals or series
 * without graphics support. JSON and the original bucket values stay untouched.
 */
export function formatExploreTimeSeriesHuman(
  data: ExploreTimeSeriesData,
): string {
  const scope = data.project ? `${data.org}/${data.project}` : data.org;
  const details = [
    `Querying ${escapeMarkdownInline(data.dataset)} in ${escapeMarkdownInline(scope)}:`,
  ];
  if (data.meta?.start !== undefined && data.meta.end !== undefined) {
    details.push(
      `Range (UTC): ${formatUtcTimestamp(data.meta.start)} to ${formatUtcTimestamp(data.meta.end)}`,
    );
  }

  const ingestion = data.meta?.ingestion;
  const hasPendingIngestion = data.timeSeries.some((series) =>
    series.values.some(
      (bucket) =>
        bucket.incomplete && bucket.incompleteReason === "INGESTION_PENDING",
    ),
  );
  if (ingestion && (hasPendingIngestion || ingestion.status === "stalled")) {
    details.push(
      `Ingestion status: ${escapeMarkdownInline(ingestion.status)}.`,
    );
    if (ingestion.delaySeconds != null) {
      details.push(
        `Reported ingestion delay: ${formatDurationCompact(ingestion.delaySeconds)}.`,
      );
    }
  }

  const header = renderMarkdown(details.join("\n\n"));
  if (data.timeSeries.length === 0) {
    return `${header}\n\nNo time series returned.`;
  }
  return `${header}\n\n${data.timeSeries.map(formatSeries).join("\n\n")}`;
}

/**
 * Omit human-only scope fields while preserving the API response. As with the
 * tabular Explore output, --fields projects each data row (here, each bucket),
 * leaving series identity and metadata available to interpret those values.
 */
export function jsonTransformExploreTimeSeries(
  data: ExploreTimeSeriesData,
  fields?: string[],
): unknown {
  const { org: _org, project: _project, ...response } = data;
  if (!fields?.length) {
    return response;
  }
  return {
    ...response,
    timeSeries: response.timeSeries.map((series) => ({
      ...series,
      values: series.values.map((bucket) => filterFields(bucket, fields)),
    })),
  };
}
