import { type ProcessedTrace, type ProcessedSpan } from "@sentry/spotlight";
import {
  getEventMetadata,
  type EventMetadata,
  type LocalFeedItem,
} from "./spotlight.ts";
import { record, text } from "./inspection.ts";
import { isErrorEvent } from "./workspace.ts";

export type TraceSpan = {
  id: string;
  parentId?: string;
  operation?: string;
  description: string;
  startTimestamp?: number;
  endTimestamp?: number;
  durationMs?: number;
  item: LocalFeedItem;
  payload: unknown;
  metadata: EventMetadata;
  children: TraceSpan[];
};

export type TraceGroup = {
  id: string;
  processed?: ProcessedTrace;
  title: string;
  items: LocalFeedItem[];
  roots: TraceSpan[];
  spans: TraceSpan[];
  logCount: number;
  errorCount: number;
  itemCount: number;
  startTimestamp?: number;
  endTimestamp?: number;
  durationMs?: number;
};

export function traceIdForItem(item: LocalFeedItem): string | undefined {
  return (
    item.metadata?.traceId ??
    (item.type === "transaction" || item.type === "span" ? item.id : undefined)
  );
}

/** Adapt shared trace assembly to Local's raw-item inspection and display model.
 * Local's presentation timestamps are wire seconds; the SDK uses milliseconds.
 */
export function adaptTraceGroups(
  items: readonly LocalFeedItem[],
  processed: readonly ProcessedTrace[],
): TraceGroup[] {
  const itemsByTrace = new Map<string, LocalFeedItem[]>();
  const rawSpans = new Map<string, { item: LocalFeedItem; payload: unknown }>();
  for (const item of items) {
    const id = traceIdForItem(item);
    if (!id) continue;
    const entries = itemsByTrace.get(id) ?? [];
    entries.push(item);
    itemsByTrace.set(id, entries);
    if (
      (item.type === "transaction" || item.type === "span") &&
      item.metadata?.spanId
    )
      rawSpans.set(`${id}:${item.metadata.spanId}`, {
        item,
        payload: item.payload,
      });
    const payload = record(item.payload);
    for (const span of Array.isArray(payload.spans) ? payload.spans : []) {
      const spanId = text(record(span).span_id);
      if (spanId) rawSpans.set(`${id}:${spanId}`, { item, payload: span });
    }
  }
  const assembled = processed
    .flatMap((trace) => {
      const entries = itemsByTrace.get(trace.trace_id);
      if (!entries?.length) return [];
      const mapped = new Map<string, TraceSpan>();
      function adapt(span: ProcessedSpan): TraceSpan {
        const previous = mapped.get(span.span_id);
        if (previous) return previous;
        const raw = rawSpans.get(`${trace.trace_id}:${span.span_id}`);
        const item = raw?.item ?? entries![0]!;
        const payload = raw?.payload ?? span;
        const duration = span.timestamp - span.start_timestamp;
        const result: TraceSpan = {
          id: span.span_id,
          parentId: span.parent_span_id ?? undefined,
          operation: span.op ?? undefined,
          description: span.description ?? span.op ?? span.span_id,
          startTimestamp: span.start_timestamp / 1000,
          endTimestamp: span.timestamp / 1000,
          durationMs:
            duration >= 0 && Number.isFinite(duration)
              ? Math.round(duration * 100) / 100
              : undefined,
          item,
          payload,
          metadata: getEventMetadata(payload, "span"),
          children: [],
        };
        mapped.set(span.span_id, result);
        return result;
      }
      // Convert the SDK's existing tree iteratively; very deep captures must not
      // use the JavaScript call stack merely to create presentation objects.
      const sharedSpans = [...trace.spans.values()];
      for (const span of sharedSpans) if (span.op !== "orphan") adapt(span);
      function visibleChildren(spans: readonly ProcessedSpan[]): TraceSpan[] {
        const visible: TraceSpan[] = [];
        const pending = [...spans].reverse();
        const visited = new Set<string>();
        while (pending.length) {
          const span = pending.pop()!;
          if (visited.has(span.span_id)) continue;
          visited.add(span.span_id);
          if (span.op === "orphan") {
            // Missing-parent wrappers can occur below real spans as well as at
            // the root. Promote their captured children at every depth.
            for (
              let index = (span.children?.length ?? 0) - 1;
              index >= 0;
              index--
            )
              pending.push(span.children![index]!);
          } else {
            visible.push(adapt(span));
          }
        }
        // Promoted children can interleave with siblings outside their wrapper.
        return visible.sort(
          (a, b) =>
            (a.startTimestamp ?? Infinity) - (b.startTimestamp ?? Infinity),
        );
      }
      for (const span of sharedSpans) {
        const local = mapped.get(span.span_id);
        if (local) local.children = visibleChildren(span.children ?? []);
      }
      const roots = visibleChildren(trace.spanTree);
      return [
        {
          id: trace.trace_id,
          processed: trace,
          title:
            trace.rootTransaction?.transaction ??
            trace.transactions[0]?.transaction ??
            entries[0]!.metadata?.title ??
            trace.rootTransactionName,
          items: entries,
          roots,
          spans: [...mapped.values()].sort(
            (a, b) =>
              (a.startTimestamp ?? Infinity) - (b.startTimestamp ?? Infinity),
          ),
          logCount: entries.filter((item) => item.type === "log").length,
          errorCount: entries.filter(isErrorEvent).length,
          itemCount: entries.length,
          startTimestamp: trace.start_timestamp / 1000,
          endTimestamp: trace.timestamp / 1000,
          durationMs:
            Math.round((trace.timestamp - trace.start_timestamp) * 100) / 100,
        },
      ];
    })
    .sort((a, b) => (b.endTimestamp ?? 0) - (a.endTimestamp ?? 0));
  // Local also presents standalone transactions that carry no trace context.
  // These are navigation groups for captured records, without invented SDK spans.
  const assembledIds = new Set(assembled.map((trace) => trace.id));
  const uncorrelated: TraceGroup[] = items
    .filter(
      (item) =>
        item.type === "transaction" &&
        !item.metadata?.traceId &&
        !assembledIds.has(item.id),
    )
    .map((item) => {
      const payload = record(item.payload);
      const start =
        typeof payload.start_timestamp === "number"
          ? payload.start_timestamp
          : undefined;
      const end =
        typeof payload.timestamp === "number" ? payload.timestamp : undefined;
      return {
        id: item.id,
        title: item.metadata?.title ?? "transaction",
        items: [item],
        roots: [],
        spans: [],
        logCount: 0,
        errorCount: 0,
        itemCount: 1,
        startTimestamp: start,
        endTimestamp: end,
        durationMs: item.metadata?.durationMs,
      };
    });
  return [...assembled, ...uncorrelated].sort(
    (a, b) => (b.endTimestamp ?? 0) - (a.endTimestamp ?? 0),
  );
}
