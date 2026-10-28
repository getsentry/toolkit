import type {
  DeepReadonly,
  ProcessedSpan,
  ProcessedTrace,
  ProfileFunctionSummary,
  TelemetrySnapshot,
} from "./public.ts";
import type { CompactQuerySummary, CompactResourceSummary } from "./reader.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type SerializedSpan = {
  [key: string]: JsonValue;
  span_id: string;
  childSpanIds: string[];
};
export type SerializedTrace = {
  [key: string]: JsonValue;
  schemaVersion: 1;
  trace_id: string;
  spans: [string, SerializedSpan][];
  spanTree: string[];
};
export type SerializedSnapshot = {
  schemaVersion: 1;
  revision: number;
  envelopes: JsonValue[];
  events: JsonValue[];
  traces: SerializedTrace[];
  logs: JsonValue[];
  sdks: JsonValue[];
  profiles: [string, JsonValue][];
};
export type SerializableSummary =
  | ((CompactQuerySummary | CompactResourceSummary) & {
      readonly spans?: never;
    })
  | ProfileFunctionSummary;
export type SerializedSummaries = { schemaVersion: 1; summaries: JsonValue[] };

/** Explicitly reject unsupported data rather than quietly replacing graph cycles with null. */
function plain(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Telemetry JSON requires finite numbers");
    return value;
  }
  if (typeof value !== "object")
    throw new TypeError("Unsupported telemetry JSON value");
  if (ancestors.has(value))
    throw new TypeError("Cycle outside span children cannot be serialized");
  ancestors.add(value);
  try {
    if (value instanceof Map)
      return Array.from(value, ([key, item]) => [
        plain(key, ancestors),
        plain(item, ancestors),
      ]);
    if (value instanceof Set)
      return Array.from(value, (item) => plain(item, ancestors));
    if (value instanceof Uint8Array) return Array.from(value);
    if (Array.isArray(value))
      return value.map((item) =>
        item === undefined ? null : plain(item, ancestors),
      );
    const record = value as Record<string, unknown>;
    const result: { [key: string]: JsonValue } = {};
    const isSpan =
      typeof record.span_id === "string" &&
      typeof record.start_timestamp === "number" &&
      typeof record.timestamp === "number";
    for (const [key, item] of Object.entries(record).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (
        item === undefined ||
        (isSpan && (key === "children" || key === "transaction"))
      )
        continue;
      Object.defineProperty(result, key, {
        value: plain(item, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (isSpan) {
      result.childSpanIds = (
        (record.children ?? []) as readonly ProcessedSpan[]
      ).map((child) => child.span_id);
      if (record.transaction)
        result.transactionEventId = (
          record.transaction as { event_id: string }
        ).event_id;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Flat span entries preserve child cycles and retain children missing from the trace's span map. */
export function serializeTrace(trace: ProcessedTrace): SerializedTrace {
  const queue: ProcessedSpan[] = [...trace.spans.values(), ...trace.spanTree];
  const canonicalIds = new Set(
    Array.from(trace.spans.values(), (span) => span.span_id),
  );
  const transactionsSeen = new Set<NonNullable<ProcessedSpan["transaction"]>>();
  function enqueueTransaction(
    transaction: NonNullable<ProcessedSpan["transaction"]>,
  ) {
    if (transactionsSeen.has(transaction)) return;
    transactionsSeen.add(transaction);
    for (const span of transaction.spans ?? []) queue.push(span);
  }
  for (const transaction of trace.transactions) enqueueTransaction(transaction);
  if (trace.rootTransaction) enqueueTransaction(trace.rootTransaction);
  const seen = new Set<ProcessedSpan>();
  const byId = new Map<string, SerializedSpan>();
  for (let index = 0; index < queue.length; index++) {
    const span = queue[index];
    if (seen.has(span)) continue;
    seen.add(span);
    const serialized = plain(span) as SerializedSpan;
    const existing = byId.get(span.span_id);
    // The trace map is authoritative over historical copies in transactions.
    // Children found only in those copies still belong in the flat graph.
    if (existing) {
      if (!canonicalIds.has(span.span_id))
        for (const [key, value] of Object.entries(serialized)) {
          if (key === "childSpanIds") continue;
          if (
            Object.hasOwn(existing, key) &&
            JSON.stringify(existing[key]) !== JSON.stringify(value)
          )
            throw new TypeError(`Conflicting span ID: ${span.span_id}`);
          Object.defineProperty(existing, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      existing.childSpanIds = Array.from(
        new Set([...existing.childSpanIds, ...serialized.childSpanIds]),
      );
    } else byId.set(span.span_id, serialized);
    for (const child of span.children ?? []) queue.push(child);
    if (span.transaction) enqueueTransaction(span.transaction);
  }
  const {
    spans: _spans,
    spanTree: _tree,
    transactions,
    rootTransaction,
    ...metadata
  } = trace;
  const transactionJson = (
    transaction: DeepReadonly<NonNullable<ProcessedTrace["rootTransaction"]>>,
  ): JsonValue => {
    const { spans, ...rest } = transaction;
    return {
      ...(plain(rest) as { [key: string]: JsonValue }),
      spanIds: (spans ?? []).map((span) => span.span_id),
    };
  };
  return {
    ...(plain(metadata) as { [key: string]: JsonValue }),
    schemaVersion: 1,
    trace_id: trace.trace_id,
    transactions: transactions.map(transactionJson),
    rootTransaction: rootTransaction ? transactionJson(rootTransaction) : null,
    spans: Array.from(byId),
    spanTree: trace.spanTree.map((span) => span.span_id),
  };
}

/** A JSON-ready DTO: Map entries and Set values become arrays; no custom JSON replacer is needed. */
export function serializeSnapshot(
  snapshot: TelemetrySnapshot,
): SerializedSnapshot {
  return {
    schemaVersion: 1,
    revision: snapshot.revision,
    envelopes: snapshot.envelopes.map((envelope) => plain(envelope)),
    events: snapshot.events.map((event) => plain(event)),
    traces: snapshot.traces.map(serializeTrace),
    logs: snapshot.logs.map((log) => plain(log)),
    sdks: snapshot.sdks.map((sdk) => plain(sdk)),
    profiles: Array.from(snapshot.profiles, ([id, profile]) => [
      id,
      plain(profile),
    ]),
  };
}

/** Serialize compact read results, including profile trace ID sets, without losing a detailed span graph. */
export function serializeSummaries(
  summaries: readonly SerializableSummary[],
): SerializedSummaries {
  return {
    schemaVersion: 1,
    summaries: summaries.map((summary) => {
      if ("spans" in summary)
        throw new TypeError(
          "Use compact summaries or serializeTrace for detailed span graphs",
        );
      return plain(summary);
    }),
  };
}
