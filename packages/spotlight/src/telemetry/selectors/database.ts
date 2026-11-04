import type { Span } from "../types.ts";
import { type SpanFilter, type SpanSummary, summarizeSpans } from "./spans.ts";

export const DB_SPAN_REGEX = /^db(?:\.[A-Za-z]+)*$/;
export type QueryFilter = SpanFilter & { description?: string };
export type QuerySummary = SpanSummary;

/** Inputs and durations use normalized milliseconds. Presentation sorting belongs to callers. */
export function getDatabaseQuerySummaries(
  spans: readonly Span[],
  filter: QueryFilter = {},
): QuerySummary[] {
  return summarizeSpans(
    spans.filter(
      (span) =>
        DB_SPAN_REGEX.test(span.op ?? "") &&
        (filter.traceId === undefined || span.trace_id === filter.traceId),
    ),
  ).filter(
    (query) =>
      filter.description === undefined ||
      query.description === filter.description.trim(),
  );
}
