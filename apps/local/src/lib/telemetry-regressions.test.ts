import { expect, test } from "vitest";
import type { ProcessedSpan } from "@sentry/spotlight";
import { adaptTraceGroups } from "./trace-model.ts";
import { decodeEnvelope } from "./spotlight.ts";
import { createLocalTelemetryStore } from "./telemetry-store.ts";
import { spanInsights } from "./performance.ts";

async function capture(items: unknown[]) {
  const store = createLocalTelemetryStore();
  const text = JSON.stringify([{}, items]);
  store.recordEnvelope(
    { id: "wire", type: "envelope", text, payload: text },
    decodeEnvelope(text, "wire"),
  );
  await store.drain();
  return store;
}

test("production log-batch wire inputs remain discoverable in the trace workspace", async () => {
  const store = await capture([
    [
      { type: "log" },
      {
        items: [
          {
            trace_id: "log-trace",
            span_id: "log-span",
            timestamp: 1700000000,
            body: "log-only trace",
            level: "info",
          },
        ],
      },
    ],
  ]);
  expect(store.getSnapshot().traceGroups).toMatchObject([
    {
      id: "log-trace",
      logCount: 1,
      title: "log-only trace",
      startTimestamp: 1700000000,
      endTimestamp: 1700000000,
      spans: [],
    },
  ]);
  store.clear();
  expect(store.getSnapshot().traceGroups).toEqual([]);
});

test("production span-v2 resource sizes use known wire aliases and omit unknown sizes", async () => {
  const attributes = [
    { "http.response.body.size": { type: "integer", value: 200 } },
    { "http.decoded_response_content_length": { type: "integer", value: 400 } },
    {},
  ];
  const store = await capture([
    [
      { type: "span" },
      {
        version: 2,
        items: attributes.map((data, index) => ({
          trace_id: "resource-trace",
          span_id: String(index),
          name: "asset.js",
          start_timestamp: 1,
          end_timestamp: 2,
          attributes: {
            "sentry.op": { type: "string", value: "resource.script" },
            ...data,
          },
        })),
      },
    ],
  ]);
  expect(
    spanInsights(store.getSnapshot().traceGroups, "resources"),
  ).toMatchObject([{ count: 3, averageBytes: 300, averageMs: 1000 }]);
});

test.each(["queries", "resources"] as const)(
  "production unnamed and blank %s spans remain discoverable with operation labels",
  async (kind) => {
    const operation = kind === "queries" ? "db.query" : "resource.script";
    const store = await capture([
      [
        { type: "transaction" },
        {
          transaction: "GET /unnamed",
          start_timestamp: 1,
          timestamp: 2,
          contexts: { trace: { trace_id: "unnamed", span_id: "root" } },
          spans: [
            {
              span_id: "missing",
              op: operation,
              start_timestamp: 1,
              timestamp: 1.1,
            },
            {
              span_id: "blank",
              op: operation,
              description: "   ",
              start_timestamp: 1.1,
              timestamp: 1.2,
            },
            {
              span_id: "named",
              op: operation,
              description: " SELECT 1 ",
              start_timestamp: 1.2,
              timestamp: 1.3,
            },
          ],
        },
      ],
    ]);
    const summaries = spanInsights(store.getSnapshot().traceGroups, kind);
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: operation,
          count: 2,
          totalMs: 200,
          averageMs: 100,
          executions: [
            expect.objectContaining({
              span: expect.objectContaining({
                id: "missing",
                description: operation,
              }),
            }),
            expect.objectContaining({
              span: expect.objectContaining({
                id: "blank",
                description: "   ",
              }),
            }),
          ],
        }),
        expect.objectContaining({
          name: "SELECT 1",
          count: 1,
          executions: [
            expect.objectContaining({
              span: expect.objectContaining({
                id: "named",
                description: " SELECT 1 ",
              }),
            }),
          ],
        }),
      ]),
    );
    expect(
      store.getSnapshot().traceGroups[0]?.processed?.spans.get("missing")
        ?.description,
    ).toBeUndefined();
  },
);

test("production missing parents under a real root retain descendants in the waterfall tree", async () => {
  const store = await capture([
    [
      { type: "transaction" },
      {
        transaction: "GET /partial",
        start_timestamp: 1,
        timestamp: 2,
        contexts: { trace: { trace_id: "partial", span_id: "root" } },
        spans: [
          {
            span_id: "child",
            parent_span_id: "missing",
            description: "child",
            start_timestamp: 1.1,
            timestamp: 1.2,
          },
          {
            span_id: "grandchild",
            parent_span_id: "child",
            description: "grandchild",
            start_timestamp: 1.11,
            timestamp: 1.15,
          },
        ],
      },
    ],
  ]);
  expect(store.getSnapshot().traceGroups[0]?.roots).toMatchObject([
    {
      id: "root",
      children: [
        { id: "child", parentId: "missing", children: [{ id: "grandchild" }] },
      ],
    },
  ]);
  expect(store.getSnapshot().traceGroups[0]?.spans).toHaveLength(3);
});

test("retention removes evicted spans from synchronous snapshots and every subscriber publication", async () => {
  const store = createLocalTelemetryStore({ limit: 2 });
  function recordSpan(id: string, payload: unknown) {
    const text = JSON.stringify([
      {},
      [[{ type: "span" }, { version: 2, items: [payload] }]],
    ]);
    store.recordEnvelope(
      { id, type: "envelope", text, payload: text },
      decodeEnvelope(text, id),
    );
  }
  recordSpan("child-envelope", {
    trace_id: "retained",
    span_id: "evicted-child",
    parent_span_id: "root",
    start_timestamp: 1.1,
    end_timestamp: 1.2,
  });
  recordSpan("parent-envelope", {
    trace_id: "retained",
    span_id: "root",
    name: "retained root",
    is_segment: true,
    start_timestamp: 1,
    end_timestamp: 2,
  });
  await store.drain();
  expect(
    store.getSnapshot().traceGroups[0]?.spans.map((span) => span.id),
  ).toContain("evicted-child");
  const publishedSpanIds: string[][] = [];
  store.subscribe(() =>
    publishedSpanIds.push(
      store
        .getSnapshot()
        .traceGroups.flatMap((trace) => trace.spans.map((span) => span.id)),
    ),
  );
  recordSpan("next-envelope", {
    trace_id: "new",
    span_id: "next",
    start_timestamp: 2,
    end_timestamp: 3,
  });
  expect(
    store
      .getSnapshot()
      .traceGroups.flatMap((trace) => trace.spans.map((span) => span.id)),
  ).not.toContain("evicted-child");
  await store.drain();
  expect(publishedSpanIds.length).toBeGreaterThanOrEqual(2);
  for (const ids of publishedSpanIds)
    expect(ids).not.toContain("evicted-child");
  expect(
    store
      .getSnapshot()
      .traceGroups.flatMap((trace) => trace.spans.map((span) => span.id))
      .sort(),
  ).toEqual(["next", "root"]);
});

test("retention changes during shared ingestion cannot republish the previous window", async () => {
  const store = createLocalTelemetryStore({ limit: 2 });
  function captureSpan(id: string) {
    const text = JSON.stringify([
      {},
      [
        [
          { type: "span" },
          {
            version: 2,
            items: [
              {
                trace_id: "same-trace",
                span_id: id,
                start_timestamp: 1,
                end_timestamp: 2,
              },
            ],
          },
        ],
      ],
    ]);
    store.recordEnvelope(
      { id, type: "envelope", text, payload: text },
      decodeEnvelope(text, id),
    );
  }
  captureSpan("evicted");
  await store.drain();
  captureSpan("second");
  // Let the shared ingestion start, then change retention before its await resumes.
  await Promise.resolve();
  const published: string[][] = [];
  store.subscribe(() =>
    published.push(
      store
        .getSnapshot()
        .traceGroups.flatMap((trace) => trace.spans.map((span) => span.id)),
    ),
  );
  captureSpan("third");
  await store.drain();
  for (const ids of published) expect(ids).not.toContain("evicted");
  expect(
    store
      .getSnapshot()
      .traceGroups[0]?.spans.map((span) => span.id)
      .sort(),
  ).toEqual(["second", "third"]);
});

test("nested orphan wrappers promote each real child once even when wrappers cycle", async () => {
  const store = await capture([
    [
      { type: "transaction" },
      {
        transaction: "partial tree",
        start_timestamp: 1,
        timestamp: 2,
        contexts: { trace: { trace_id: "partial", span_id: "root" } },
        spans: [
          {
            span_id: "child",
            parent_span_id: "missing",
            start_timestamp: 1.1,
            timestamp: 1.2,
          },
        ],
      },
    ],
  ]);
  const snapshot = store.getSnapshot();
  const processed = snapshot.traceGroups[0]!.processed!;
  const child = processed.spans.get("child")!;
  const wrapper = {
    ...child,
    span_id: "missing",
    op: "orphan",
    children: [] as ProcessedSpan[],
  };
  const nested: ProcessedSpan = {
    ...wrapper,
    span_id: "nested",
    children: [wrapper, child],
  };
  wrapper.children = [nested];
  const root: ProcessedSpan = {
    ...processed.spans.get("root")!,
    children: [wrapper],
  };
  const [trace] = adaptTraceGroups(snapshot.items, [
    {
      ...processed,
      spans: new Map([
        ["root", root],
        ["missing", wrapper],
        ["nested", nested],
        ["child", child],
      ]),
      spanTree: [root],
    },
  ]);
  expect(trace?.roots).toMatchObject([
    { id: "root", children: [{ id: "child" }] },
  ]);
  expect(trace?.roots[0]?.children).toHaveLength(1);
  expect(trace?.spans.map((span) => span.id)).toEqual(["root", "child"]);
});
