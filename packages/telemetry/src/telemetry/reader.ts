import { readonlyCopy } from "./internal/readonly.ts";
import type {
  AITrace,
  DeepReadonly,
  ProcessedEvent,
  ProcessedLog,
  ProcessedProfile,
  ProcessedSpan,
  ProcessedTrace,
  ProfileFunctionSummary,
  QuerySummary,
  ResourceSummary,
  TelemetrySnapshot,
} from "./public.ts";
import {
  getAITraces,
  getDatabaseQuerySummaries,
  getProfileFunctionSummaries,
  getResourceSummaries,
  getWebVitals,
} from "./selectors/index.ts";
import type {
  Sdk,
  SentryErrorEvent,
  SentryEvent,
  SentryEventWithPerformanceData,
  Span,
  Trace,
} from "./types.ts";
import { isErrorEvent } from "./utils/sentry.ts";

/** Inclusive bounds in Unix milliseconds. No implicit limit is applied to getters. */
export type TelemetryReadFilter = {
  readonly fromMs?: number;
  readonly toMs?: number;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
};
export type TraceReadFilter = TelemetryReadFilter & {
  readonly traceId?: string;
};
export type EventReadFilter = TraceReadFilter & { readonly spanId?: string };
export type SummaryReadFilter = TraceReadFilter & {
  readonly includeSpans?: boolean;
};
export type DatabaseReadFilter = SummaryReadFilter & {
  readonly description?: string;
};
export type CompactQuerySummary = Omit<QuerySummary, "spans">;
export type CompactResourceSummary = Omit<ResourceSummary, "spans">;
export type ReadCollection = "events" | "traces" | "logs" | "spans";
export type ReadPageOptions = EventReadFilter & { readonly cursor?: string };
export type ReadCollectionItem<C extends ReadCollection> = {
  events: ProcessedEvent;
  traces: ProcessedTrace;
  logs: ProcessedLog;
  spans: ProcessedSpan;
}[C];
export type ReadPageResult<T> =
  | {
      readonly status: "ok";
      readonly revision: number;
      readonly items: readonly T[];
      readonly total: number;
      readonly nextCursor?: string;
    }
  | {
      readonly status: "invalid";
      readonly revision: number;
      readonly code: "stale_cursor" | "invalid_cursor" | "invalid_query";
      readonly message: string;
    };
export type TelemetryReader = {
  getSnapshot(): TelemetrySnapshot;
  getEnvelope(id: string): TelemetrySnapshot["envelopes"][number] | undefined;
  getEnvelopes(): TelemetrySnapshot["envelopes"];
  getEvent(id: string): ProcessedEvent | undefined;
  getEvents(filter?: EventReadFilter): readonly ProcessedEvent[];
  getErrors(
    filter?: EventReadFilter,
  ): readonly DeepReadonly<SentryErrorEvent>[];
  getTrace(id: string): ProcessedTrace | undefined;
  getTraces(filter?: TraceReadFilter): readonly ProcessedTrace[];
  getSpans(filter?: TraceReadFilter): readonly ProcessedSpan[];
  getLog(id: string): ProcessedLog | undefined;
  getLogs(filter?: TraceReadFilter): readonly ProcessedLog[];
  getProfile(traceId: string): ProcessedProfile | undefined;
  getProfileFunctionSummaries(
    filter?: TraceReadFilter,
  ): readonly ProfileFunctionSummary[];
  getDatabaseQuerySummaries(
    filter: DatabaseReadFilter & { includeSpans: true },
  ): readonly QuerySummary[];
  getDatabaseQuerySummaries(
    filter?: DatabaseReadFilter & { includeSpans?: false },
  ): readonly CompactQuerySummary[];
  getDatabaseQuerySummaries(
    filter?: DatabaseReadFilter,
  ): readonly (CompactQuerySummary & {
    readonly spans?: QuerySummary["spans"];
  })[];
  getResourceSummaries(
    filter: SummaryReadFilter & { includeSpans: true },
  ): readonly ResourceSummary[];
  getResourceSummaries(
    filter?: SummaryReadFilter & { includeSpans?: false },
  ): readonly CompactResourceSummary[];
  getResourceSummaries(
    filter?: SummaryReadFilter,
  ): readonly (CompactResourceSummary & {
    readonly spans?: ResourceSummary["spans"];
  })[];
  getAITraces(filter?: TraceReadFilter): readonly AITrace[];
  getWebVitals(
    filter?: EventReadFilter,
  ): readonly DeepReadonly<SentryEventWithPerformanceData>[];
  getSdks(): readonly DeepReadonly<Sdk>[];
  readPage<C extends ReadCollection>(
    collection: C,
    options?: ReadPageOptions,
  ): ReadPageResult<ReadCollectionItem<C>>;
};

function validate(filter: ReadPageOptions, paged = false) {
  for (const value of [filter.fromMs, filter.toMs])
    if (value !== undefined && !Number.isFinite(value))
      throw new RangeError("Time bounds must be finite Unix milliseconds");
  if (
    filter.fromMs !== undefined &&
    filter.toMs !== undefined &&
    filter.fromMs > filter.toMs
  )
    throw new RangeError("fromMs must not exceed toMs");
  if (
    filter.order !== undefined &&
    filter.order !== "asc" &&
    filter.order !== "desc"
  )
    throw new RangeError("order must be asc or desc");
  if (
    filter.limit !== undefined &&
    (!Number.isSafeInteger(filter.limit) ||
      filter.limit < 1 ||
      (paged && filter.limit > 1000))
  )
    throw new RangeError(
      paged
        ? "Page limit must be between 1 and 1000"
        : "limit must be a positive safe integer",
    );
  for (const value of [filter.traceId, filter.spanId])
    if (value !== undefined && typeof value !== "string")
      throw new RangeError("IDs must be strings");
}
function canonical(value: object): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, item]) =>
            item !== undefined &&
            !(key === "order" && item === "asc") &&
            !(key === "includeSpans" && item === false),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
function within(timestamp: number, filter: TelemetryReadFilter) {
  return (
    (filter.fromMs === undefined || timestamp >= filter.fromMs) &&
    (filter.toMs === undefined || timestamp <= filter.toMs)
  );
}
function ordered<T>(
  items: readonly T[],
  filter: TelemetryReadFilter,
  time: (item: T) => number,
  id: (item: T) => string,
): readonly T[] {
  const direction = filter.order === "desc" ? -1 : 1;
  return Object.freeze(
    items
      .filter((item) => within(time(item), filter))
      .sort(
        (a, b) =>
          direction *
          (time(a) - time(b) || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0)),
      )
      .slice(0, filter.limit),
  );
}
function named<T>(
  items: readonly T[],
  filter: TelemetryReadFilter,
  name: (item: T) => string,
): readonly T[] {
  return ordered(
    items,
    { order: filter.order, limit: filter.limit },
    () => 0,
    name,
  );
}

/** A portable read-only dependency. The current revision retains at most 256 recently used reads. */
export function createTelemetryReader(
  getSnapshot: () => TelemetrySnapshot,
): TelemetryReader {
  let revision = -1;
  const cache = new Map<string, unknown>();
  function read<T>(
    name: string,
    filter: object,
    derive: (snapshot: TelemetrySnapshot) => T,
  ): T {
    const snapshot = getSnapshot();
    if (revision !== snapshot.revision) {
      cache.clear();
      revision = snapshot.revision;
    }
    const key = `${name}:${canonical(filter)}`;
    if (cache.has(key)) {
      const value = cache.get(key) as T;
      cache.delete(key);
      cache.set(key, value);
      return value;
    }
    const value = derive(snapshot);
    cache.set(key, value);
    if (cache.size > 256) cache.delete(cache.keys().next().value!);
    return value;
  }
  const traces = (snapshot: TelemetrySnapshot, filter: TraceReadFilter) =>
    snapshot.traces.filter(
      (trace) =>
        filter.traceId === undefined || trace.trace_id === filter.traceId,
    );
  // Legacy transaction child spans need not carry trace_id. Scope their owning trace first.
  const spans = (snapshot: TelemetrySnapshot, filter: TraceReadFilter) =>
    traces(snapshot, filter).flatMap((trace) =>
      Array.from(trace.spans.values()),
    );
  function events(snapshot: TelemetrySnapshot, filter: EventReadFilter) {
    return snapshot.events.filter(
      (event) =>
        (filter.traceId === undefined ||
          event.contexts?.trace?.trace_id === filter.traceId ||
          (event.type === "span" && event.span.trace_id === filter.traceId)) &&
        (filter.spanId === undefined ||
          event.contexts?.trace?.span_id === filter.spanId ||
          (event.type === "span" && event.span.span_id === filter.spanId)),
    );
  }
  const reader: TelemetryReader = {
    getSnapshot,
    getEnvelope: (id) =>
      getSnapshot().envelopes.find(
        (envelope) => String(envelope[0].__spotlight_envelope_id) === id,
      ),
    getEnvelopes: () => getSnapshot().envelopes,
    getEvent: (id) =>
      getSnapshot().events.find((event) => event.event_id === id),
    getEvents(filter = {}) {
      validate(filter);
      return read("events", filter, (snapshot) =>
        ordered(
          events(snapshot, filter),
          filter,
          (event) => event.timestamp,
          (event) => event.event_id,
        ),
      );
    },
    getErrors(filter = {}) {
      validate(filter);
      return read("errors", filter, (snapshot) =>
        ordered(
          events(snapshot, filter).filter((event) =>
            isErrorEvent(event as SentryEvent),
          ) as readonly DeepReadonly<SentryErrorEvent>[],
          filter,
          (event) => event.timestamp,
          (event) => event.event_id,
        ),
      );
    },
    getTrace: (id) =>
      getSnapshot().traces.find((trace) => trace.trace_id === id),
    getTraces(filter = {}) {
      validate(filter);
      return read("traces", filter, (snapshot) =>
        ordered(
          traces(snapshot, filter),
          filter,
          (trace) => trace.timestamp,
          (trace) => trace.trace_id,
        ),
      );
    },
    getSpans(filter = {}) {
      validate(filter);
      return read("spans", filter, (snapshot) =>
        ordered(
          spans(snapshot, filter),
          filter,
          (span) => span.timestamp,
          (span) => span.span_id,
        ),
      );
    },
    getLog: (id) => getSnapshot().logs.find((log) => log.id === id),
    getLogs(filter = {}) {
      validate(filter);
      return read("logs", filter, (snapshot) =>
        ordered(
          snapshot.logs.filter(
            (log) =>
              filter.traceId === undefined || log.trace_id === filter.traceId,
          ),
          filter,
          (log) => log.timestamp,
          (log) => log.id,
        ),
      );
    },
    getProfile: (id) => getSnapshot().profiles.get(id),
    getProfileFunctionSummaries(filter = {}) {
      validate(filter);
      return read("profiles", filter, (snapshot) =>
        readonlyCopy(
          named(
            getProfileFunctionSummaries(
              new Map(
                Array.from(snapshot.profiles).filter(
                  ([id, profile]) =>
                    (filter.traceId === undefined || id === filter.traceId) &&
                    within(profile.timestamp, filter),
                ),
              ) as unknown as Parameters<typeof getProfileFunctionSummaries>[0],
            ),
            filter,
            (summary) => summary.name,
          ),
        ),
      );
    },
    getDatabaseQuerySummaries: ((input?: DatabaseReadFilter) => {
      const filter = input ?? {};
      validate(filter);
      if (
        filter.description !== undefined &&
        typeof filter.description !== "string"
      )
        throw new RangeError("description must be a string");
      if (
        filter.includeSpans !== undefined &&
        typeof filter.includeSpans !== "boolean"
      )
        throw new RangeError("includeSpans must be boolean");
      return read("queries", filter, (snapshot) =>
        readonlyCopy(
          named(
            getDatabaseQuerySummaries(
              ordered(
                spans(snapshot, filter),
                {
                  fromMs: filter.fromMs,
                  toMs: filter.toMs,
                  order: filter.order,
                },
                (span) => span.timestamp,
                (span) => span.span_id,
              ) as Span[],
              { description: filter.description },
            ).map((summary) => {
              const { spans: detail, ...compact } = summary;
              return filter.includeSpans
                ? { ...compact, spans: detail }
                : compact;
            }),
            filter,
            (summary) => summary.description,
          ),
        ),
      );
    }) as TelemetryReader["getDatabaseQuerySummaries"],
    getResourceSummaries: ((input?: SummaryReadFilter) => {
      const filter = input ?? {};
      validate(filter);
      if (
        filter.includeSpans !== undefined &&
        typeof filter.includeSpans !== "boolean"
      )
        throw new RangeError("includeSpans must be boolean");
      return read("resources", filter, (snapshot) =>
        readonlyCopy(
          named(
            getResourceSummaries(
              ordered(
                spans(snapshot, filter),
                {
                  fromMs: filter.fromMs,
                  toMs: filter.toMs,
                  order: filter.order,
                },
                (span) => span.timestamp,
                (span) => span.span_id,
              ) as Span[],
            ).map((summary) => {
              const { spans: detail, ...compact } = summary;
              return filter.includeSpans
                ? { ...compact, spans: detail }
                : compact;
            }),
            filter,
            (summary) => summary.description,
          ),
        ),
      );
    }) as TelemetryReader["getResourceSummaries"],
    getAITraces(filter = {}) {
      validate(filter);
      return read("ai", filter, (snapshot) =>
        readonlyCopy(
          ordered(
            getAITraces(traces(snapshot, filter) as Trace[]),
            filter,
            (trace) => trace.timestamp,
            (trace) => trace.id,
          ),
        ),
      );
    },
    getWebVitals(filter = {}) {
      validate(filter);
      return read("vitals", filter, (snapshot) =>
        readonlyCopy(
          ordered(
            getWebVitals(events(snapshot, filter) as SentryEvent[]),
            filter,
            (event) => event.timestamp,
            (event) => event.event_id,
          ),
        ),
      );
    },
    getSdks: () => getSnapshot().sdks,
    readPage(collection, options = {}) {
      const invalid = (
        code: "invalid_query" | "invalid_cursor" | "stale_cursor",
        message: string,
      ) =>
        Object.freeze({
          status: "invalid" as const,
          revision: getSnapshot().revision,
          code,
          message,
        });
      try {
        validate(options, true);
        if (!["events", "traces", "logs", "spans"].includes(collection))
          throw new RangeError("Unknown collection");
        if (collection !== "events" && options.spanId !== undefined)
          throw new RangeError("spanId is only supported for events");
      } catch (error) {
        return invalid(
          "invalid_query",
          error instanceof Error ? error.message : "Invalid query",
        );
      }
      const { cursor, ...filter } = options;
      const query = canonical({
        ...filter,
        order: filter.order ?? "asc",
        limit: filter.limit ?? 100,
      });
      const snapshot = getSnapshot();
      let offset = 0;
      if (cursor !== undefined) {
        try {
          if (typeof cursor !== "string" || cursor.length > 16384)
            throw new Error();
          const parsed = JSON.parse(decodeURIComponent(cursor));
          if (
            parsed.version !== 1 ||
            !Number.isSafeInteger(parsed.revision) ||
            !Number.isSafeInteger(parsed.offset) ||
            parsed.offset < 1 ||
            parsed.collection !== collection ||
            parsed.query !== query
          )
            throw new Error();
          if (parsed.revision !== snapshot.revision)
            return invalid(
              "stale_cursor",
              "The snapshot changed; restart pagination",
            );
          offset = parsed.offset;
        } catch {
          return invalid("invalid_cursor", "Cursor does not match this query");
        }
      }
      return read(`page:${collection}`, { query, cursor }, () => {
        const { limit: _limit, ...allFilter } = filter;
        const items =
          collection === "events"
            ? reader.getEvents(allFilter)
            : collection === "traces"
              ? reader.getTraces(allFilter)
              : collection === "logs"
                ? reader.getLogs(allFilter)
                : reader.getSpans(allFilter);
        if (offset > items.length || offset % (filter.limit ?? 100) !== 0)
          return invalid(
            "invalid_cursor",
            "Cursor offset is outside this query",
          );
        const end = offset + (filter.limit ?? 100);
        return Object.freeze({
          status: "ok" as const,
          revision: snapshot.revision,
          items: Object.freeze(items.slice(offset, end)),
          total: items.length,
          ...(end < items.length
            ? {
                nextCursor: encodeURIComponent(
                  JSON.stringify({
                    version: 1,
                    revision: snapshot.revision,
                    collection,
                    query,
                    offset: end,
                  }),
                ),
              }
            : {}),
        });
      }) as ReadPageResult<ReadCollectionItem<typeof collection>>;
    },
  };
  return Object.freeze(reader);
}
