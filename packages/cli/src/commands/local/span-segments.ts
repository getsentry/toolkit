/**
 * Segments of a streamed span batch (span v2): which spans belong together,
 * the span that heads each group, and the name to show for it.
 *
 * Dependency-free: `local event list` and the tail share it, so both name the
 * same batch the same way.
 */

import { parseEventTimestamp } from "./timestamp.js";

/** The span fields segment grouping reads. */
export type SegmentSpan = {
  span_id?: unknown;
  parent_span_id?: unknown;
  is_segment?: unknown;
  name?: unknown;
  start_timestamp?: unknown;
  attributes?: unknown;
};

/** Spans of one segment that arrived in the same batch. */
export type SpanSegment<T extends SegmentSpan> = {
  /** The segment span, or the top span of the group when it is missing. */
  head: T;
  /** Whether {@link head} is the segment span itself, not just its top span. */
  isSegment: boolean;
  /** The segment's name: its span name, or `sentry.segment.name` without it. */
  name: string | undefined;
  spans: T[];
};

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** The value of a typed span attribute (`{ key: { type, value } }`). */
function spanAttribute(span: SegmentSpan, key: string): unknown {
  const attributes = span.attributes as
    | Record<string, { value?: unknown } | undefined>
    | undefined;
  return attributes?.[key]?.value;
}

/**
 * The segment a span belongs to: its `sentry.segment.id`, its own ID when it
 * is a segment, else the top ancestor found in the same batch.
 */
function segmentKey(
  span: SegmentSpan,
  byId: ReadonlyMap<string, SegmentSpan>,
): string | undefined {
  const segmentId = text(spanAttribute(span, "sentry.segment.id"));
  if (segmentId) {
    return segmentId;
  }
  let top = span;
  const seen = new Set<SegmentSpan>();
  while (
    top.is_segment !== true &&
    typeof top.parent_span_id === "string" &&
    !seen.has(top)
  ) {
    seen.add(top);
    const parent = byId.get(top.parent_span_id);
    if (!parent) {
      break;
    }
    top = parent;
  }
  return text(top.span_id);
}

/**
 * Whether a span is a segment: flagged `is_segment`, its own
 * `sentry.segment.id`, or a root span with no parent.
 */
function isSegmentSpan(span: SegmentSpan): boolean {
  return (
    span.is_segment === true ||
    !span.parent_span_id ||
    (span.span_id !== undefined &&
      span.span_id === spanAttribute(span, "sentry.segment.id"))
  );
}

/**
 * Group a span batch by segment, in the order each segment first appears.
 * Spans with no span or segment ID each form their own group. SDKs list
 * child spans first, because they end first.
 */
export function groupSpansBySegment<T extends SegmentSpan>(
  spans: readonly T[],
): SpanSegment<T>[] {
  const byId = new Map<string, T>();
  for (const span of spans) {
    if (typeof span.span_id === "string" && span.span_id) {
      byId.set(span.span_id, span);
    }
  }
  const groups = new Map<string | T, [T, ...T[]]>();
  for (const span of spans) {
    const key = segmentKey(span, byId) ?? span;
    const group = groups.get(key);
    if (group) {
      group.push(span);
    } else {
      groups.set(key, [span]);
    }
  }
  return [...groups.values()].map((group) => {
    const segment = group.find(isSegmentSpan);
    // Without its segment, the group's top span is the one whose parent is
    // not in the batch and that started first.
    const top = group
      .filter(
        (span) =>
          !(
            typeof span.parent_span_id === "string" &&
            byId.has(span.parent_span_id)
          ),
      )
      .sort(
        (a, b) =>
          (parseEventTimestamp(a.start_timestamp) ?? 0) -
          (parseEventTimestamp(b.start_timestamp) ?? 0),
      )[0];
    const head = segment ?? top ?? group[0];
    const segmentName = text(spanAttribute(head, "sentry.segment.name"));
    return {
      head,
      isSegment: segment !== undefined,
      name: segment
        ? (text(head.name) ?? segmentName)
        : (segmentName ?? text(head.name)),
      spans: group,
    };
  });
}

/**
 * The spans of a group the tail counts on its line: every span but the
 * segment span (`[N spans]`), or every span when the segment is missing
 * (`[+N spans]`).
 */
export function countedSpans(group: SpanSegment<SegmentSpan>): number {
  return group.isSegment ? group.spans.length - 1 : group.spans.length;
}

/**
 * The segment that names a whole batch, from its {@link groupSpansBySegment}
 * groups: the first group whose segment span is in the batch, else the first
 * group.
 */
export function batchSegment<T extends SegmentSpan>(
  groups: readonly SpanSegment<T>[],
): SpanSegment<T> | undefined {
  return groups.find((group) => group.isSegment) ?? groups[0];
}
