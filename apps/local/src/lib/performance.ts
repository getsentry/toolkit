import type { LocalFeedItem } from "./spotlight.ts";
import type { TraceGroup, TraceSpan } from "./trace-model.ts";
import { finite, record, spanData, text } from "./inspection.ts";
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
  const groups = new Map<string, SpanInsight>();
  for (const trace of traces)
    for (const span of trace.spans) {
      if (
        !(kind === "queries" ? /^db(?:\.|$)/ : /^resource(?:\.|$)/).test(
          span.operation ?? "",
        )
      )
        continue;
      const id = `${span.operation}:${span.description}`;
      const group = groups.get(id) ?? {
        id,
        name: span.description,
        operation: span.operation ?? "",
        count: 0,
        executions: [],
      };
      group.count++;
      group.executions.push({
        traceId: trace.id,
        traceTitle: trace.title,
        span,
      });
      groups.set(id, group);
    }
  for (const group of groups.values()) {
    const durations = group.executions.flatMap((entry) =>
      entry.span.durationMs === undefined ? [] : [entry.span.durationMs],
    );
    if (durations.length) {
      group.totalMs = durations.reduce((a, b) => a + b, 0);
      group.averageMs = group.totalMs / durations.length;
    }
    const sizes = group.executions.flatMap((entry) => {
      const data = spanData(entry.span.payload);
      const size =
        finite(data["http.response_content_length"]) ??
        finite(data["http.response.body.size"]) ??
        finite(data["http.decoded_response_content_length"]);
      return size === undefined || size < 0 ? [] : [size];
    });
    if (sizes.length)
      group.averageBytes = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  }
  return [...groups.values()];
}
export const VITALS = {
  lcp: { label: "LCP", unit: "ms", good: 2500, poor: 4000 },
  inp: { label: "INP", unit: "ms", good: 200, poor: 500 },
  cls: { label: "CLS", unit: "", good: 0.1, poor: 0.25 },
  fcp: { label: "FCP", unit: "ms", good: 1800, poor: 3000 },
  ttfb: { label: "TTFB", unit: "ms", good: 800, poor: 1800 },
  fid: { label: "FID (legacy)", unit: "ms", good: 100, poor: 300 },
} as const;
export type VitalName = keyof typeof VITALS;
export type VitalMeasurement = {
  value: number;
  rating: "Good" | "Needs improvement" | "Poor";
};
export type VitalVisit = {
  item: LocalFeedItem;
  metrics: Partial<Record<VitalName, VitalMeasurement>>;
};
export type VitalPage = { name: string; visits: VitalVisit[] };
export function webVitalPages(items: readonly LocalFeedItem[]): VitalPage[] {
  const pages = new Map<string, VitalPage>();
  for (const item of items) {
    const p = record(item.payload),
      measurements = record(p.measurements);
    if (item.type !== "transaction" || !Object.keys(measurements).length)
      continue;
    const metrics: VitalVisit["metrics"] = {};
    for (const name of Object.keys(VITALS) as VitalName[]) {
      const metric = record(measurements[name]),
        value = finite(metric.value);
      if (value === undefined || value < 0) continue;
      const config = VITALS[name];
      // SDK measurements normally use milliseconds; honor seconds when explicitly supplied.
      const normalized =
        config.unit === "ms" && metric.unit === "second" ? value * 1000 : value;
      metrics[name] = {
        value: normalized,
        rating:
          normalized <= config.good
            ? "Good"
            : normalized <= config.poor
              ? "Needs improvement"
              : "Poor",
      };
    }
    if (!Object.keys(metrics).length) continue;
    const name = text(p.transaction) ?? item.metadata?.route ?? "Unknown page";
    const page = pages.get(name) ?? { name, visits: [] };
    page.visits.push({ item, metrics });
    pages.set(name, page);
  }
  return [...pages.values()].sort((a, b) => a.name.localeCompare(b.name));
}
