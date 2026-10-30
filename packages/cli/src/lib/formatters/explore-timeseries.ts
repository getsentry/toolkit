/**
 * Human charts/tables and JSON output for Explore aggregates bucketed over time.
 * Keeps response metadata and bucket values intact for machine consumers.
 */

import type { EventsTimeSeriesResponse } from "../api/explore.js";
import { formatLegendLabel } from "./chart-presentation.js";
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
  const chart =
    series.values.length > 0 ? formatExploreTimeSeriesChart(series) : undefined;
  const details: string[] = [];
  // Every admitted Explore chart has room for its single fitted legend label.
  // Keep the original expression when its fitted label omits more than syntax.
  if (!chart || formatLegendLabel(series.yAxis).abbreviated) {
    details.push(
      `**${escapeMarkdownInline(series.yAxis)}${chart ? "" : " over time"}**`,
    );
  }
  details.push(`Interval: ${formatDurationCompactMs(series.meta.interval)}`);
  // The typed axis formatter appends units only for duration and size values.
  const unitOnAxis =
    chart &&
    (series.meta.valueType === "duration" || series.meta.valueType === "size");
  if (
    !unitOnAxis &&
    series.meta.valueUnit &&
    series.meta.valueUnit !== "none"
  ) {
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

  const caption = renderMarkdown(details.join(chart ? " · " : "\n\n"));
  if (series.values.length === 0) {
    return `${caption}\n\nNo time buckets returned.`;
  }

  if (!chart) {
    return `${caption}\n\n${formatBuckets(series, series.values)}`;
  }
  const gaps = series.values.filter(
    (bucket) => bucket.value === null || bucket.incomplete,
  );
  const gapDetails =
    gaps.length > 0
      ? `\n\n${renderMarkdown("Missing or incomplete buckets:")}\n\n${formatBuckets(series, gaps)}`
      : "";
  return `${chart}\n${caption}${gapDetails}`;
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
    `Querying ${escapeMarkdownInline(data.dataset)} in ${escapeMarkdownInline(scope)}`,
  ];
  if (data.meta?.start !== undefined && data.meta.end !== undefined) {
    details.push(
      `Range (UTC): ${formatUtcTimestamp(data.meta.start)} to ${formatUtcTimestamp(data.meta.end)}`,
    );
  }

  const ingestion = data.meta?.ingestion;
  const ingestionDetails: string[] = [];
  const hasPendingIngestion = data.timeSeries.some((series) =>
    series.values.some(
      (bucket) =>
        bucket.incomplete && bucket.incompleteReason === "INGESTION_PENDING",
    ),
  );
  if (ingestion && (hasPendingIngestion || ingestion.status === "stalled")) {
    ingestionDetails.push(
      `Ingestion status: ${escapeMarkdownInline(ingestion.status)}.`,
    );
    if (ingestion.delaySeconds != null) {
      ingestionDetails.push(
        `Reported ingestion delay: ${formatDurationCompact(ingestion.delaySeconds)}.`,
      );
    }
  }

  const sections = [
    renderMarkdown(details.join(" · ")),
    data.timeSeries.length === 0
      ? "No time series returned."
      : data.timeSeries.map(formatSeries).join("\n\n"),
  ];
  if (ingestionDetails.length > 0) {
    sections.push(renderMarkdown(ingestionDetails.join(" · ")));
  }
  return sections.join("\n\n");
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
