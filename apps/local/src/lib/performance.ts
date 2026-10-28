import {
  createTelemetryReader,
  groupWebVitalPages,
  type VitalVisit as SharedVitalVisit,
  type TelemetrySnapshot,
} from "@sentry/telemetry";
import type { LocalFeedItem } from "./spotlight.ts";
import type { TraceGroup, TraceSpan } from "./trace-model.ts";
import { record, text } from "./inspection.ts";
export type SpanInsight = {
  id: string;
  name: string;
  operation: string;
  count: number;
  totalMs?: number;
  averageMs?: number;
  averageBytes?: number;
  executions: { traceId: string; traceTitle: string; span: TraceSpan }[];
};
export function spanInsights(
  traces: readonly TraceGroup[],
  kind: "queries" | "resources",
): SpanInsight[] {
  const reader = createTelemetryReader(
    () =>
      ({
        revision: 0,
        envelopes: [],
        events: [],
        logs: [],
        sdks: [],
        profiles: new Map(),
        traces: traces.flatMap(({ processed }) =>
          processed
            ? [
                {
                  ...processed,
                  spans: new Map(
                    [...processed.spans].map(([id, span]) => [
                      id,
                      { ...span, trace_id: processed.trace_id },
                    ]),
                  ),
                },
              ]
            : [],
        ),
      }) satisfies TelemetrySnapshot,
  );
  const summaries =
    kind === "queries"
      ? reader.getDatabaseQuerySummaries({ includeSpans: true })
      : reader.getResourceSummaries({ includeSpans: true });
  return summaries.map((summary) => {
    const executions = summary.spans.flatMap((processed) => {
      // Embedded legacy spans need their containing trace to resolve their ID.
      const trace = traces.find((trace) => trace.id === processed.trace_id);
      const span = trace?.spans.find((span) => span.id === processed.span_id);
      return trace && span
        ? [{ traceId: trace.id, traceTitle: trace.title, span }]
        : [];
    });
    return {
      id: summary.description,
      name: summary.description,
      operation: summary.spans[0]?.op ?? "",
      count: summary.count,
      totalMs: summary.totalDurationMs,
      averageMs: summary.averageDurationMs,
      averageBytes:
        "averageSizeBytes" in summary &&
        typeof summary.averageSizeBytes === "number"
          ? summary.averageSizeBytes
          : undefined,
      executions,
    };
  });
}

export { WEB_VITALS as VITALS } from "@sentry/telemetry";
export type { VitalName, VitalMeasurement } from "@sentry/telemetry";
export type VitalVisit = {
  item: LocalFeedItem;
  metrics: SharedVitalVisit["metrics"];
};
export type VitalPage = { name: string; visits: VitalVisit[] };
export function webVitalPages(items: readonly LocalFeedItem[]): VitalPage[] {
  const byId = new Map(items.map((item, index) => [String(index), item]));
  const pages = groupWebVitalPages(
    items.flatMap((item, index) => {
      if (item.type !== "transaction") return [];
      const payload = record(item.payload);
      return [
        {
          id: String(index),
          transaction: text(payload.transaction) ?? item.metadata?.route,
          measurements: payload.measurements,
        },
      ];
    }),
  );
  return pages.map((page) => ({
    ...page,
    visits: page.visits.map((visit) => ({
      item: byId.get(visit.eventId)!,
      metrics: visit.metrics,
    })),
  }));
}
