/**
 * Span tree utilities
 *
 * Shared helper for fetching and formatting span trees from trace data.
 */

import type { SentryEvent, TraceSpan } from "../types/index.js";
import { getDetailedTrace } from "./api-client.js";
import { formatSimpleSpanTree, muted } from "./formatters/index.js";
import { logger } from "./logger.js";

const log = logger.withTag("span-tree");

/**
 * Truncate a span tree to a maximum depth.
 * Returns a new array with children beyond maxDepth removed.
 *
 * @param spans - Array of spans to truncate
 * @param maxDepth - Maximum depth to keep (1 = root only)
 * @param currentDepth - Current depth in recursion (internal use)
 * @returns New array with truncated children
 */
function truncateSpanTree(
  spans: TraceSpan[],
  maxDepth: number,
  currentDepth = 1
): TraceSpan[] {
  if (currentDepth > maxDepth) {
    return [];
  }

  return spans.map((span) => ({
    ...span,
    children: span.children
      ? truncateSpanTree(span.children, maxDepth, currentDepth + 1)
      : undefined,
  }));
}

/**
 * Result from fetching span tree data.
 * Contains both formatted lines for human output and raw spans for JSON output.
 */
export type SpanTreeResult = {
  /** Formatted lines ready for display (human output) */
  lines: string[];
  /** Raw span data for JSON output (null if fetch failed) */
  spans: TraceSpan[] | null;
  /** Trace ID for context (null if not available) */
  traceId: string | null;
  /** Whether the fetch was successful */
  success: boolean;
};

/**
 * Fetch and format span tree data for an event.
 * Returns both formatted lines for human output and raw spans for JSON output.
 *
 * @param orgSlug - Organization slug for API routing
 * @param event - The event to get trace from
 * @param maxDepth - Maximum nesting depth to display (for formatted lines)
 * @returns Formatted lines, raw spans, trace ID, and success status
 */
export async function getSpanTreeLines(
  orgSlug: string,
  event: SentryEvent,
  maxDepth: number
): Promise<SpanTreeResult> {
  const traceId = event.contexts?.trace?.trace_id ?? null;
  const parsed = event.dateCreated
    ? new Date(event.dateCreated).getTime() / 1000
    : undefined;
  const timestamp =
    parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;

  if (!traceId) {
    return {
      lines: [muted("\nNo trace data available for this event.")],
      spans: null,
      traceId: null,
      success: false,
    };
  }

  try {
    const spans = await getDetailedTrace(
      orgSlug,
      traceId,
      timestamp === undefined ? {} : { timestamp }
    );
    const lines = formatSimpleSpanTree(traceId, spans, maxDepth);
    // Truncate spans to match depth limit for JSON output
    const truncatedSpans =
      maxDepth === Number.POSITIVE_INFINITY
        ? spans
        : truncateSpanTree(spans, maxDepth);
    return { lines, spans: truncatedSpans, traceId, success: true };
  } catch (error) {
    log.debug("Failed to fetch span tree", error);
    return {
      lines: [muted("\nUnable to fetch span tree for this event.")],
      spans: null,
      traceId,
      success: false,
    };
  }
}
