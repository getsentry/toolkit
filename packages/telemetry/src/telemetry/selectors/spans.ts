import type { Span, Trace } from "../types.ts";

export type SpanFilter = { traceId?: string };

export type SpanSummary = {
  description: string;
  count: number;
  totalDurationMs: number;
  averageDurationMs: number;
  spans: Span[];
};

export function getSpans(
  traces: Iterable<Trace>,
  filter: SpanFilter = {},
): Span[] {
  return Array.from(traces)
    .filter(
      (trace) =>
        filter.traceId === undefined || trace.trace_id === filter.traceId,
    )
    .flatMap((trace) => Array.from(trace.spans.values()));
}

/** Groups normalized spans by description, preserving their input order. Durations are milliseconds. */
export function summarizeSpans(spans: Iterable<Span>): SpanSummary[] {
  const groups = new Map<string, SpanSummary>();
  for (const span of spans) {
    const description = span.description?.trim();
    if (
      !description ||
      !Number.isFinite(span.timestamp) ||
      !Number.isFinite(span.start_timestamp)
    )
      continue;
    const group = groups.get(description) ?? {
      description,
      count: 0,
      totalDurationMs: 0,
      averageDurationMs: 0,
      spans: [],
    };
    group.count += 1;
    group.totalDurationMs += span.timestamp - span.start_timestamp;
    group.averageDurationMs = group.totalDurationMs / group.count;
    group.spans.push(span);
    groups.set(description, group);
  }
  return Array.from(groups.values());
}
