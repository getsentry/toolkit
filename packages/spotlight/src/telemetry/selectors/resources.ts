import type { Span } from "../types.ts";
import { type SpanSummary, summarizeSpans } from "./spans.ts";

export type ResourceSummary = SpanSummary & {
  averageEncodedSizeBytes: number;
  /** Best available captured response size. Unknown sizes are excluded. */
  averageSizeBytes?: number;
};

function knownResourceSize(span: Span): number | undefined {
  for (const key of [
    "http.response_content_length",
    "http.response.body.size",
    "http.decoded_response_content_length",
  ]) {
    const value = span.data?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value;
  }
  return undefined;
}

export function getResourceSummaries(
  spans: readonly Span[],
): ResourceSummary[] {
  return summarizeSpans(
    spans.filter((span) => /resource\.[A-Za-z]+/.test(span.op ?? "")),
  ).map((group) => {
    const sizes = group.spans.flatMap((span) => {
      const size = knownResourceSize(span);
      return size === undefined ? [] : [size];
    });
    return {
      ...group,
      averageEncodedSizeBytes:
        group.spans.reduce((sum, span) => {
          const size = span.data?.["http.response_content_length"];
          return (
            sum +
            (typeof size === "number" && Number.isFinite(size) && size >= 0
              ? size
              : 0)
          );
        }, 0) / group.count,
      ...(sizes.length
        ? {
            averageSizeBytes:
              sizes.reduce((sum, size) => sum + size, 0) / sizes.length,
          }
        : {}),
    };
  });
}
