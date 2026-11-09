import { tableCell, text } from "@sentry/toolkit-core/markdown";
import type { TransformedTimeseriesResult } from "../../types/dashboard.js";
import { renderMarkdown } from "./markdown.js";
import { formatTable } from "./table.js";

export function formatDashboardTransformations(
  title: string,
  data: TransformedTimeseriesResult,
): string {
  const sections = [
    renderMarkdown(`**${text(title)}**`),
    "Exact transformed values. null marks a gap.",
  ];
  for (const query of data.queries) {
    sections.push(
      `Query ${query.queryIndex + 1}. Requested interval: ${query.requestedInterval ?? "auto"}.`,
    );
    if (query.response.meta) {
      sections.push(JSON.stringify(query.response.meta));
    }
    if (query.response.timeSeries.length === 0) {
      sections.push("No time series returned. Executed interval unavailable.");
    }
    for (const [index, series] of query.response.timeSeries.entries()) {
      const axisIndex = index % query.yAxes.length;
      const group = series.meta.isOther
        ? "Other"
        : JSON.stringify(series.groupBy ?? []);
      sections.push(
        renderMarkdown(
          `Query ${query.queryIndex + 1}, axis ${axisIndex + 1}. ${text(series.yAxis)}. Group: ${text(group)}.`,
        ),
      );
      sections.push(
        `Transformations: ${JSON.stringify(query.transformations[String(axisIndex)] ?? [])}`,
      );
      sections.push(
        `Executed interval: ${series.meta.interval} ms. Unit: ${series.meta.valueUnit ?? "none"}.`,
      );
      sections.push(JSON.stringify(series.meta));
      if (series.values.length === 0) {
        sections.push("No time buckets returned.");
        continue;
      }
      const fields = [
        ...new Set(series.values.flatMap((bucket) => Object.keys(bucket))),
      ];
      sections.push(
        formatTable(
          series.values,
          fields.map((field) => ({
            header: tableCell(field === "timestamp" ? "TIME (UTC)" : field),
            value: (bucket) =>
              tableCell(
                field === "timestamp"
                  ? new Date(bucket.timestamp).toISOString()
                  : (JSON.stringify(bucket[field]) ?? ""),
              ),
            shrinkable: false,
          })),
        ),
      );
    }
  }
  return sections.join("\n\n");
}
