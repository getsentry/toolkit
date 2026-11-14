import {
  getEventMetadata,
  type EventMetadata,
  type LocalFeedItem,
} from "./spotlight.js";
import { isErrorEvent } from "./workspace.js";
import { withoutUndefined } from "./objects.ts";
import { addProfileSpans, profileSources } from "./profile-spans.ts";

export type TraceSpan = {
  sampled?: boolean;
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
  profileSpansTruncated?: boolean;
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
  spanUpdates: Map<string, TraceSpan[]>;
  titleCandidates: Set<string>;
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
  const contexts = isRecord(payload["contexts"]) ? payload["contexts"] : {};
  return isRecord(contexts["trace"]) ? contexts["trace"] : {};
}

function getPayloadSpan(
  payload: unknown,
  item: LocalFeedItem,
): TraceSpan | undefined {
  const event = isRecord(payload) ? payload : {};
  const trace = getTraceContext(payload);
  const id = getString(trace["span_id"]) ?? item.metadata?.spanId;
  if (!id) {
    return undefined;
  }
  const startTimestamp = getTimestamp(event["start_timestamp"]);
  const endTimestamp =
    getTimestamp(event["timestamp"]) ??
    getTimestamp(event["end_timestamp"]) ??
    getTimestamp(item.timestamp);
  const operation = getString(trace["op"]) ?? item.metadata?.operation;
  const title = item.metadata?.title.trim();
  const description =
    getString(event["transaction"]) ??
    (title && title !== item.type ? title : undefined) ??
    item.metadata?.route ??
    operation ??
    item.type;

  return withoutUndefined({
    id,
    parentId:
      getString(trace["parent_span_id"]) ?? getString(event["parent_span_id"]),
    operation,
    description,
    startTimestamp,
    endTimestamp,
    durationMs: getDurationMs(startTimestamp, endTimestamp),
    item,
    payload,
    metadata: item.metadata ?? getEventMetadata(payload, item.type),
    children: [],
  });
}

function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function mergeSpan(
  previous: TraceSpan | undefined,
  next: TraceSpan,
): TraceSpan {
  if (!previous) return next;
  // Completion time decides conflicting captured values. Name quality is
  // independent: a later fallback label must not erase a captured name.
  // Raw feed items stay untouched.
  const rank = (span: TraceSpan) => {
    const description = span.description.trim();
    const named =
      description &&
      description !== span.operation &&
      description !== span.id &&
      description !== span.item.type;
    const payload = isRecord(span.payload) ? span.payload : {};
    const captured = [
      payload["transaction"],
      payload["description"],
      payload["name"],
    ].some(
      (value) => typeof value === "string" && value.trim() === description,
    );
    return named ? (captured ? 4 : 2) : 0;
  };
  const [primary, secondary] =
    (previous.endTimestamp ?? -Infinity) > (next.endTimestamp ?? -Infinity)
      ? [previous, next]
      : [next, previous];
  const description =
    rank(secondary) > rank(primary)
      ? secondary.description
      : primary.description;
  const merge = (left: unknown, right: unknown) => ({
    ...defined(isRecord(left) ? left : {}),
    ...defined(isRecord(right) ? right : {}),
  });
  const payload = merge(secondary.payload, primary.payload);
  for (const key of ["data", "attributes", "contexts"]) {
    const left = isRecord(secondary.payload)
      ? secondary.payload[key]
      : undefined;
    const right = isRecord(primary.payload) ? primary.payload[key] : undefined;
    if (isRecord(left) || isRecord(right)) payload[key] = merge(left, right);
  }
  const leftTrace = getTraceContext(secondary.payload);
  const rightTrace = getTraceContext(primary.payload);
  if (Object.keys(leftTrace).length || Object.keys(rightTrace).length) {
    const contexts = isRecord(payload["contexts"]) ? payload["contexts"] : {};
    payload["contexts"] = {
      ...contexts,
      trace: {
        ...merge(leftTrace, rightTrace),
        data: merge(leftTrace["data"], rightTrace["data"]),
      },
    };
  }
  const starts = [previous.startTimestamp, next.startTimestamp].filter(
    (value): value is number => value !== undefined,
  );
  const ends = [previous.endTimestamp, next.endTimestamp].filter(
    (value): value is number => value !== undefined,
  );
  const startTimestamp = starts.length ? Math.min(...starts) : undefined;
  const endTimestamp = ends.length ? Math.max(...ends) : undefined;
  const durationMs = getDurationMs(startTimestamp, endTimestamp);
  return withoutUndefined({
    ...secondary,
    ...primary,
    description,
    parentId: primary.parentId ?? secondary.parentId,
    operation: primary.operation ?? secondary.operation,
    startTimestamp,
    endTimestamp,
    durationMs,
    payload,
    metadata: withoutUndefined({
      ...defined(secondary.metadata),
      ...defined(primary.metadata),
      title: description,
      durationMs,
    }),
  });
}

function getChildSpans(payload: unknown, item: LocalFeedItem): TraceSpan[] {
  const event = isRecord(payload) ? payload : {};
  if (!Array.isArray(event["spans"])) {
    return [];
  }

  return event["spans"].flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }
    const id = getString(value["span_id"]);
    if (!id) {
      return [];
    }
    const startTimestamp = getTimestamp(value["start_timestamp"]);
    const endTimestamp = getTimestamp(value["timestamp"]);
    const operation = getString(value["op"]);
    return [
      withoutUndefined({
        id,
        parentId: getString(value["parent_span_id"]),
        operation,
        description: getString(value["description"]) ?? operation ?? id,
        startTimestamp,
        endTimestamp,
        durationMs: getDurationMs(startTimestamp, endTimestamp),
        item,
        payload: value,
        metadata: getEventMetadata(value, "span"),
        children: [],
      }),
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
  let start = Infinity;
  let end = -Infinity;
  function includeTimestamp(timestamp: number | undefined): void {
    if (timestamp === undefined) return;
    start = Math.min(start, timestamp);
    end = Math.max(end, timestamp);
  }
  for (const item of trace.items)
    includeTimestamp(getTimestamp(item.timestamp));
  for (const span of trace.spanMap.values()) {
    includeTimestamp(span.startTimestamp);
    includeTimestamp(span.endTimestamp);
  }
  if (start === Infinity) return;
  trace.startTimestamp = start;
  trace.endTimestamp = end;
  const durationMs = getDurationMs(start, end);
  if (durationMs === undefined) delete trace.durationMs;
  else trace.durationMs = durationMs;
}

/** Build a small, read-only trace model once for every view in Local. */
export function buildTraceGroups(
  items: readonly LocalFeedItem[],
): TraceGroup[] {
  const traces = new Map<string, MutableTraceGroup>();
  const profiles = profileSources(items);

  for (const item of items) {
    if (item.type === "profile" || item.type === "profile_chunk") continue;
    const traceId = traceIdForItem(item);
    if (!traceId) {
      continue;
    }

    const trace: MutableTraceGroup = traces.get(traceId) ?? {
      id: traceId,
      title: item.metadata?.title ?? item.type,
      titleCandidates: new Set(),
      items: [],
      logCount: 0,
      errorCount: 0,
      spanMap: new Map(),
      spanUpdates: new Map(),
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
        const updates = trace.spanUpdates.get(rootSpan.id) ?? [];
        updates.push(rootSpan);
        trace.spanUpdates.set(rootSpan.id, updates);
        const isSegment =
          isRecord(item.payload) && item.payload["is_segment"] === true;
        if (item.type === "transaction" || isSegment) {
          trace.titleCandidates.add(rootSpan.id);
        }
      }
    }
    for (const childSpan of getChildSpans(item.payload, item)) {
      const updates = trace.spanUpdates.get(childSpan.id) ?? [];
      updates.push(childSpan);
      trace.spanUpdates.set(childSpan.id, updates);
    }
  }

  return [...traces.values()]
    .map((trace) => {
      // Fold original captures in completion order: a partial update's maximum
      // end time must not become the clock of older fields it merely retained.
      for (const [id, updates] of trace.spanUpdates) {
        updates.sort(
          (left, right) =>
            (left.endTimestamp ?? -Infinity) -
            (right.endTimestamp ?? -Infinity),
        );
        let merged: TraceSpan | undefined;
        for (const update of updates) merged = mergeSpan(merged, update);
        if (merged) trace.spanMap.set(id, merged);
      }
      updateTraceTiming(trace);
      // A partial update can turn a former root into a child. Select from final
      // merged spans rather than retaining a priority from an earlier delivery.
      let titlePriority = -1;
      for (const id of trace.titleCandidates) {
        const span = trace.spanMap.get(id);
        if (!span) continue;
        const named =
          span.description.trim() &&
          span.description !== span.operation &&
          span.description !== span.id &&
          span.description !== span.item.type;
        const priority = (span.parentId ? 1 : 2) * 10 + (named ? 1 : 0);
        if (priority > titlePriority) {
          trace.title = named
            ? span.description.trim()
            : (span.operation ?? span.id);
          titlePriority = priority;
        }
      }
      const spans = sortByTimestamp([...trace.spanMap.values()]);
      const roots: TraceSpan[] = [];
      for (const span of spans) {
        span.children = [];
      }
      // Parent links form a functional graph. Break one edge per cycle for
      // display, preserving the wire parentId and visiting each node once.
      const visited = new Set<string>();
      const cycleRoots = new Set<string>();
      for (const span of spans) {
        const path: string[] = [];
        const positions = new Map<string, number>();
        let current: TraceSpan | undefined = span;
        while (current && !visited.has(current.id)) {
          const position = positions.get(current.id);
          if (position !== undefined) {
            let rootId = current.id;
            for (const pathId of path.slice(position)) {
              if (pathId < rootId) rootId = pathId;
            }
            cycleRoots.add(rootId);
            break;
          }
          positions.set(current.id, path.length);
          path.push(current.id);
          current = current.parentId
            ? trace.spanMap.get(current.parentId)
            : undefined;
        }
        for (const id of path) visited.add(id);
      }
      for (const span of spans) {
        const parent = span.parentId
          ? trace.spanMap.get(span.parentId)
          : undefined;
        if (parent && parent !== span && !cycleRoots.has(span.id)) {
          parent.children.push(span);
        } else {
          roots.push(span);
        }
      }
      for (const span of spans) {
        sortByTimestamp(span.children);
      }

      return withoutUndefined({
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
      });
    })
    .map((trace) => addProfileSpans(trace, profiles))
    .sort(
      (left, right) => (right.endTimestamp ?? 0) - (left.endTimestamp ?? 0),
    );
}
