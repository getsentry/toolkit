// @vitest-environment node
import { expect, test } from "vitest";
import type { TelemetrySnapshot } from "./public.ts";
import { createTelemetryReader } from "./reader.ts";
import type { Span, Trace } from "./types.ts";
function fixture() {
  const spans: Span[] = [
    {
      span_id: "b",
      start_timestamp: 10,
      timestamp: 20,
      op: "db.query",
      description: "SELECT 1",
    },
    {
      span_id: "a",
      start_timestamp: 5,
      timestamp: 20,
      op: "db.query",
      description: "SELECT 1",
    },
    {
      span_id: "c",
      start_timestamp: 25,
      timestamp: 30,
      op: "resource.script",
      description: "script.js",
      data: { "http.response_content_length": 40 },
    },
  ];
  const trace: Trace = {
    trace_id: "trace",
    transactions: [],
    errors: 0,
    start_timestamp: 5,
    timestamp: 30,
    rootTransaction: null,
    rootTransactionName: "",
    spans: new Map(spans.map((span) => [span.span_id, span])),
    spanTree: spans,
    profileGrafted: false,
  };
  const snapshot: TelemetrySnapshot = {
    revision: 1,
    envelopes: [],
    events: [
      {
        event_id: "b",
        timestamp: 20,
        exception: { value: undefined, values: [] },
      },
      {
        event_id: "a",
        timestamp: 20,
        exception: { value: undefined, values: [] },
      },
      {
        event_id: "c",
        timestamp: 30,
        exception: { value: undefined, values: [] },
      },
    ],
    traces: [trace],
    logs: [],
    sdks: [],
    profiles: new Map(),
  };
  return { snapshot, spans };
}
test("inclusive milliseconds and deterministic IDs apply without truncating defaults", () => {
  const { snapshot } = fixture();
  const reader = createTelemetryReader(() => snapshot);
  expect(
    reader.getEvents({ fromMs: 20, toMs: 20 }).map((event) => event.event_id),
  ).toEqual(["a", "b"]);
  expect(
    reader
      .getEvents({ order: "desc", limit: 2 })
      .map((event) => event.event_id),
  ).toEqual(["c", "b"]);
  expect(
    reader
      .getSpans({ traceId: "trace", fromMs: 20, toMs: 20 })
      .map((span) => span.span_id),
  ).toEqual(["a", "b"]);
  expect(reader.getSpans({ traceId: "other" })).toEqual([]);
  const many = {
    ...snapshot,
    events: Array.from({ length: 1200 }, (_, n) => ({
      event_id: String(n),
      timestamp: n,
      exception: { value: undefined, values: [] },
    })),
  };
  expect(createTelemetryReader(() => many).getEvents()).toHaveLength(1200);
});
test("invalid getter filters throw", () => {
  const { snapshot } = fixture();
  const reader = createTelemetryReader(() => snapshot);
  for (const filter of [
    { fromMs: Number.NaN },
    { fromMs: 20, toMs: 10 },
    { limit: 0 },
    { limit: 1.5 },
    { order: "sideways" },
  ])
    expect(() =>
      reader.getEvents(filter as Parameters<typeof reader.getEvents>[0]),
    ).toThrow(RangeError);
});
test("summaries default to compact and preserve trace-less legacy spans", () => {
  const { snapshot } = fixture();
  const reader = createTelemetryReader(() => snapshot);
  expect(
    reader.getDatabaseQuerySummaries({ traceId: "trace", toMs: 20 }),
  ).toEqual([
    {
      description: "SELECT 1",
      count: 2,
      totalDurationMs: 25,
      averageDurationMs: 12.5,
    },
  ]);
  expect(
    reader.getDatabaseQuerySummaries({ includeSpans: true })[0].spans,
  ).toHaveLength(2);
  expect(reader.getResourceSummaries()).toEqual([
    {
      description: "script.js",
      count: 1,
      totalDurationMs: 5,
      averageDurationMs: 5,
      averageEncodedSizeBytes: 40,
      averageSizeBytes: 40,
    },
  ]);
  expect(
    reader.getResourceSummaries({ includeSpans: true })[0].spans,
  ).toHaveLength(1);
});
test("canonical filters share cached identity until revision changes", () => {
  let { snapshot } = fixture();
  const reader = createTelemetryReader(() => snapshot);
  const first = reader.getDatabaseQuerySummaries({
    traceId: "trace",
    fromMs: 10,
  });
  expect(
    reader.getDatabaseQuerySummaries({ fromMs: 10, traceId: "trace" }),
  ).toBe(first);
  expect(reader.getEvents()).toBe(reader.getEvents({}));
  snapshot = { ...snapshot, revision: 2 };
  expect(
    reader.getDatabaseQuerySummaries({ fromMs: 10, traceId: "trace" }),
  ).not.toBe(first);
});
test("page cursors bind collection, canonical query and revision", () => {
  let { snapshot } = fixture();
  const reader = createTelemetryReader(() => snapshot);
  const first = reader.readPage("events", { limit: 1, fromMs: 20 });
  expect(first).toMatchObject({
    status: "ok",
    revision: 1,
    total: 3,
    items: [{ event_id: "a" }],
  });
  if (first.status !== "ok") throw new Error("expected page");
  expect(
    reader.readPage("events", {
      fromMs: 20,
      limit: 1,
      cursor: first.nextCursor,
    }),
  ).toMatchObject({
    status: "ok",
    items: [{ event_id: "b" }],
  });
  expect(
    reader.readPage("logs", { fromMs: 20, limit: 1, cursor: first.nextCursor }),
  ).toMatchObject({
    status: "invalid",
    code: "invalid_cursor",
  });
  expect(
    reader.readPage("events", {
      fromMs: 21,
      limit: 1,
      cursor: first.nextCursor,
    }),
  ).toMatchObject({
    status: "invalid",
    code: "invalid_cursor",
  });
  snapshot = { ...snapshot, revision: 2 };
  expect(
    reader.readPage("events", {
      fromMs: 20,
      limit: 1,
      cursor: first.nextCursor,
    }),
  ).toMatchObject({
    status: "invalid",
    code: "stale_cursor",
  });
  expect(reader.readPage("events", { cursor: "bad" })).toMatchObject({
    status: "invalid",
    code: "invalid_cursor",
  });
  expect(reader.readPage("events", { limit: 1001 })).toMatchObject({
    status: "invalid",
    code: "invalid_query",
  });
  expect(reader.readPage("events", { fromMs: 30, toMs: 20 })).toMatchObject({
    status: "invalid",
    code: "invalid_query",
  });
});
test("pages default to 100 and memoize result", () => {
  const { snapshot } = fixture();
  const many = {
    ...snapshot,
    events: Array.from({ length: 1200 }, (_, n) => ({
      event_id: String(n),
      timestamp: n,
      exception: { value: undefined, values: [] },
    })),
  };
  const reader = createTelemetryReader(() => many);
  const page = reader.readPage("events");
  expect(page.status === "ok" && page.items.length).toBe(100);
  expect(reader.readPage("events", {})).toBe(page);
});

test("explicit default filter values share cached results", () => {
  const { snapshot } = fixture();
  const reader = createTelemetryReader(() => snapshot);
  expect(reader.getEvents({ order: "asc" })).toBe(reader.getEvents());
  expect(reader.getDatabaseQuerySummaries({ includeSpans: false })).toBe(
    reader.getDatabaseQuerySummaries(),
  );
});

test("web vitals apply limit after selecting measurements", () => {
  const { snapshot } = fixture();
  const measured = {
    event_id: "vital",
    timestamp: 40,
    type: "transaction" as const,
    start_timestamp: 30,
    contexts: { trace: { trace_id: "trace", op: "pageload" } },
    measurements: {
      fcp: { value: 100, unit: "millisecond" },
      lcp: { value: 100, unit: "millisecond" },
      cls: { value: 0, unit: "" },
      ttfb: { value: 50, unit: "millisecond" },
      fid: { value: 10, unit: "millisecond" },
    },
  };
  const reader = createTelemetryReader(() => ({
    ...snapshot,
    events: [...snapshot.events, measured],
  }));
  expect(
    reader.getWebVitals({ limit: 1 }).map((event) => event.event_id),
  ).toEqual(["vital"]);
});

test("reader bounds cached queries while retaining recent identities", () => {
  const { snapshot } = fixture();
  const reader = createTelemetryReader(() => snapshot);
  const oldest = reader.getEvents({ fromMs: -1 });
  const recent = reader.getEvents({ fromMs: 0 });
  for (let index = 1; index <= 260; index++) {
    reader.getEvents({ fromMs: index });
    expect(reader.getEvents({ fromMs: 0 })).toBe(recent);
  }
  expect(reader.getEvents({ fromMs: -1 })).not.toBe(oldest);
  expect(reader.readPage("events", { limit: 0 })).toMatchObject({
    revision: 1,
  });
});
