import { listSavedAggregateTransformations } from "@sentry/toolkit-core/dashboard-transformations";
import { text } from "@sentry/toolkit-core/markdown";
import type { DashboardWidgetQuery } from "../../types/dashboard.js";

/**
 * Markdown bullets describing a widget's saved transformations, one per
 * aggregate position that has any. Empty when none are saved, so widgets
 * without transformations keep their existing output.
 */
export function formatSavedTransformationLines(
  queries: readonly DashboardWidgetQuery[] | undefined,
): string[] {
  return (queries ?? []).flatMap((query, queryIndex) =>
    (
      listSavedAggregateTransformations(
        query.aggregates ?? [],
        query.transformations,
      ) ?? []
    )
      .filter((entry) => entry.transformations.length > 0)
      .map((entry) => `- Query ${queryIndex + 1} · ${text(entry.description)}`),
  );
}

/**
 * Markdown section describing every widget's saved transformations, or an
 * empty string when no widget has any.
 */
export function formatDashboardSavedTransformations(
  widgets: readonly {
    title: string;
    queries?: readonly DashboardWidgetQuery[];
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
