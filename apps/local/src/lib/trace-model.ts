import {
  getEventMetadata,
  type EventMetadata,
  type LocalFeedItem,
} from "./spotlight.js";
import { isErrorEvent } from "./workspace.js";

export type TraceSpan = {
  id: string;
  parentId?: string;
  operation?: string;
  description: string;
  startTimestamp?: number;
  endTimestamp?: number;
  durationMs?: number;
  item: LocalFeedItem;
  metadata: EventMetadata;
  children: TraceSpan[];
};

export type TraceGroup = {
  id: string;
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

type MutableTraceGroup = Omit<TraceGroup, "roots" | "spans" | "itemCount"> & {
  spanMap: Map<string, TraceSpan>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function getTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function getTraceContext(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return {};
  }
  const contexts = isRecord(payload.contexts) ? payload.contexts : {};
  return isRecord(contexts.trace) ? contexts.trace : {};
}

function getPayloadSpan(
  payload: unknown,
  item: LocalFeedItem,
): TraceSpan | undefined {
  const event = isRecord(payload) ? payload : {};
  const trace = getTraceContext(payload);
  const id = getString(trace.span_id) ?? item.metadata?.spanId;
  if (!id) {
    return undefined;
  }
  const startTimestamp = getTimestamp(event.start_timestamp);
  const endTimestamp =
    getTimestamp(event.timestamp) ??
    getTimestamp(event.end_timestamp) ??
    getTimestamp(item.timestamp);
  const operation = getString(trace.op) ?? item.metadata?.operation;
  const description =
    getString(event.transaction) ??
    item.metadata?.route ??
    item.metadata?.title ??
    operation ??
    item.type;

  return {
    id,
    parentId:
      getString(trace.parent_span_id) ?? getString(event.parent_span_id),
    operation,
    description,
    startTimestamp,
    endTimestamp,
    durationMs: getDurationMs(startTimestamp, endTimestamp),
    item,
    metadata: item.metadata ?? getEventMetadata(payload, item.type),
    children: [],
  };
}

function getChildSpans(payload: unknown, item: LocalFeedItem): TraceSpan[] {
  const event = isRecord(payload) ? payload : {};
  if (!Array.isArray(event.spans)) {
    return [];
  }

  return event.spans.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }
    const id = getString(value.span_id);
    if (!id) {
      return [];
    }
    const startTimestamp = getTimestamp(value.start_timestamp);
    const endTimestamp = getTimestamp(value.timestamp);
    const operation = getString(value.op);
    return [
      {
        id,
        parentId: getString(value.parent_span_id),
        operation,
        description: getString(value.description) ?? operation ?? id,
        startTimestamp,
        endTimestamp,
        durationMs: getDurationMs(startTimestamp, endTimestamp),
        item,
        metadata: getEventMetadata(value, "span"),
        children: [],
      },
    ];
  });
}

function getDurationMs(
  startTimestamp: number | undefined,
  endTimestamp: number | undefined,
): number | undefined {
  if (
    startTimestamp === undefined ||
    endTimestamp === undefined ||
    endTimestamp < startTimestamp
  ) {
    return undefined;
  }
  return Math.round((endTimestamp - startTimestamp) * 100_000) / 100;
}

export function traceIdForItem(item: LocalFeedItem): string | undefined {
  return (
    item.metadata?.traceId ??
    (item.type === "transaction" || item.type === "span" ? item.id : undefined)
  );
}

function sortByTimestamp<T extends { startTimestamp?: number }>(
  items: T[],
): T[] {
  return items.sort(
    (left, right) =>
      (left.startTimestamp ?? Infinity) - (right.startTimestamp ?? Infinity),
  );
}

function updateTraceTiming(trace: MutableTraceGroup): void {
  const timestamps = trace.items
    .flatMap((item) => [getTimestamp(item.timestamp)])
    .concat(
      [...trace.spanMap.values()].flatMap((span) => [
        span.startTimestamp,
        span.endTimestamp,
      ]),
    )
    .filter((timestamp): timestamp is number => timestamp !== undefined);

  if (timestamps.length === 0) {
    return;
  }

  trace.startTimestamp = Math.min(...timestamps);
  trace.endTimestamp = Math.max(...timestamps);
  trace.durationMs = getDurationMs(trace.startTimestamp, trace.endTimestamp);
}

/** Build a small, read-only trace model once for every view in Local. */
export function buildTraceGroups(
  items: readonly LocalFeedItem[],
): TraceGroup[] {
  const traces = new Map<string, MutableTraceGroup>();

  for (const item of items) {
    const traceId = traceIdForItem(item);
    if (!traceId) {
      continue;
    }

    const trace: MutableTraceGroup = traces.get(traceId) ?? {
      id: traceId,
      title: item.metadata?.title ?? item.type,
      items: [],
      logCount: 0,
      errorCount: 0,
      spanMap: new Map(),
    };
    if (!traces.has(traceId)) {
      traces.set(traceId, trace);
    }

    trace.items.push(item);
    if (item.type === "log") {
      trace.logCount += 1;
    }
    if (isErrorEvent(item)) {
      trace.errorCount += 1;
    }

    if (item.type === "transaction" || item.type === "span") {
      const rootSpan = getPayloadSpan(item.payload, item);
      if (rootSpan) {
        trace.spanMap.set(rootSpan.id, rootSpan);
      }
    }
    for (const childSpan of getChildSpans(item.payload, item)) {
      trace.spanMap.set(childSpan.id, childSpan);
    }
    updateTraceTiming(trace);
  }

  return [...traces.values()]
    .map((trace) => {
      const spans = sortByTimestamp([...trace.spanMap.values()]);
      const roots: TraceSpan[] = [];
      for (const span of spans) {
        span.children = [];
      }
      for (const span of spans) {
        const parent = span.parentId
          ? trace.spanMap.get(span.parentId)
          : undefined;
        if (parent && parent !== span) {
          parent.children.push(span);
        } else {
          roots.push(span);
        }
      }
      for (const span of spans) {
        sortByTimestamp(span.children);
      }

      return {
        id: trace.id,
        title: trace.title,
        items: trace.items,
        roots: sortByTimestamp(roots),
        spans,
        logCount: trace.logCount,
        errorCount: trace.errorCount,
        itemCount: trace.items.length,
        startTimestamp: trace.startTimestamp,
        endTimestamp: trace.endTimestamp,
        durationMs: trace.durationMs,
      };
    })
    .sort(
      (left, right) => (right.endTimestamp ?? 0) - (left.endTimestamp ?? 0),
    );
}
