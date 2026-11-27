import { listSavedAggregateTransformations } from "@sentry/toolkit-core/dashboard-transformations";
import { inlineCode, text } from "@sentry/toolkit-core/markdown";
import type { DashboardWidgetQuery } from "../../types/dashboard.js";
import { formatSeriesExpression, seriesTargets } from "../dashboard-series.js";

/**
 * Markdown bullets for every saved aggregate position, including empty
 * transformation lists. Reports unavailable settings when the server omits them.
 * Empty when every query reports no saved transformations.
 *
 * Transformed series of the first query, which `widget edit --transform`
 * changes, also show how that flag writes them.
 */
export function formatSavedTransformationLines(
  queries: readonly DashboardWidgetQuery[] | undefined,
): string[] {
  return (queries ?? []).flatMap((query, queryIndex) => {
    const transformations = listSavedAggregateTransformations(
      query.aggregates ?? [],
      query.transformations,
    );
    if (transformations === null) {
      return [
        `- Query ${queryIndex + 1} · unavailable (this Sentry server does not report transformations)`,
      ];
    }
    const targets = seriesTargets(query.aggregates ?? []);
    return (transformations ?? []).map((entry) => {
      const target = targets[entry.aggregateIndex];
      const series =
        queryIndex === 0 &&
        target !== undefined &&
        entry.transformations.length > 0
          ? ` · ${inlineCode(formatSeriesExpression(target, entry.transformations))}`
          : "";
      return `- Query ${queryIndex + 1} · ${text(entry.description)}${series}`;
    });
  });
}

/**
 * Markdown section describing saved transformations and unavailable settings,
 * or an empty string when no widget has either.
 */
export function formatDashboardSavedTransformations(
  widgets: readonly {
    title: string;
    queries?: readonly DashboardWidgetQuery[] | undefined;
  }[],
): string {
  const sections = widgets.flatMap((widget) => {
    const lines = formatSavedTransformationLines(widget.queries);
    return lines.length > 0 ? ["", `**${text(widget.title)}**`, ...lines] : [];
  });
  return sections.length > 0
    ? ["### Saved transformations", ...sections].join("\n")
    : "";
}
