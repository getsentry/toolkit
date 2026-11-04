import { describe, expect, test } from "vitest";
import { decodeEnvelope, type LocalFeedItem } from "./spotlight.ts";
import { createLocalTelemetryStore } from "./telemetry-store.ts";

function item(overrides: Partial<LocalFeedItem>): LocalFeedItem {
  return {
    id: "event-1:0",
    type: "transaction",
    text: "{}",
    payload: {},
    metadata: { title: "GET /checkout" },
    ...overrides,
  };
}

describe("LocalTelemetryStore", () => {
  test("retains every decoded item in the retained envelopes and grows without clearing", () => {
    const store = createLocalTelemetryStore({ limit: 2 });
    const raw = (id: string) => item({ id, type: "envelope" });
    store.recordEnvelope(raw("one"), [
      item({ id: "one:0" }),
      item({ id: "one:1" }),
      item({ id: "one:2" }),
    ]);
    store.recordEnvelope(raw("two"), [item({ id: "two:0" })]);
    expect(store.getSnapshot().items).toHaveLength(4);
    store.setLimit(3);
    expect(store.getSnapshot().items).toHaveLength(4);
    store.recordEnvelope(raw("three"), [item({ id: "three:0" })]);
    expect(store.getSnapshot().envelopes).toHaveLength(3);
    store.recordEnvelope(raw("four"), [item({ id: "four:0" })]);
    expect(store.getSnapshot().items.map((entry) => entry.id)).toEqual([
      "two:0",
      "three:0",
      "four:0",
    ]);
  });

  test("indexes a bounded session by its observability view", () => {
    const store = createLocalTelemetryStore({ limit: 3 });

    const entries = [
      item({ id: "transaction:0", type: "transaction" }),
      item({
        id: "error:0",
        type: "event",
        metadata: { title: "Checkout failed", level: "error" },
      }),
      item({ id: "log:0", type: "log" }),
      item({ id: "feedback:0", type: "user_report" }),
    ];
    for (const entry of entries)
      store.recordEnvelope(
        item({ id: `envelope-${entry.id}`, type: "envelope" }),
        [entry],
      );

    const snapshot = store.getSnapshot();
    expect(snapshot.items.map((entry) => entry.id)).toEqual([
      "error:0",
      "log:0",
      "feedback:0",
    ]);
    expect(snapshot.errors.map((entry) => entry.id)).toEqual(["error:0"]);
    expect(snapshot.logs.map((entry) => entry.id)).toEqual(["log:0"]);
    expect(snapshot.feedback.map((entry) => entry.id)).toEqual(["feedback:0"]);
    expect(snapshot.traces).toEqual([]);
  });

  test("deduplicates replayed envelopes and clears derived indexes", () => {
    const store = createLocalTelemetryStore();
    const transaction = item({ id: "transaction:0", type: "transaction" });

    const envelope = item({ id: "envelope-1", type: "envelope" });
    store.recordEnvelope(envelope, [transaction]);
    store.recordEnvelope(envelope, [transaction]);
    expect(store.getSnapshot().items).toHaveLength(1);
    expect(store.getSnapshot().traces).toEqual([transaction]);

    store.clear();
    expect(store.getSnapshot()).toMatchObject({
      items: [],
      errors: [],
      traces: [],
      logs: [],
      feedback: [],
      envelopes: [],
      attachments: [],
      profiles: [],
      sdks: [],
      ai: [],
    });
  });

  test("retains raw envelopes separately from decoded feed items", () => {
    const store = createLocalTelemetryStore();
    const envelope = item({
      id: "envelope-1",
      type: "envelope",
      text: "[{}, []]",
    });

    store.recordEnvelope(envelope);

    expect(store.getSnapshot().items).toEqual([]);
    expect(store.getSnapshot().envelopes).toEqual([envelope]);
  });
});

test("shared processing assembles streamed traces and keeps the original capture", async () => {
  const store = createLocalTelemetryStore({ limit: 2 });
  const capture = (id: string, payload: unknown) => {
    const text = JSON.stringify([
      {},
      [[{ type: "span" }, { version: 2, items: [payload] }]],
    ]);
    const envelope = item({ id, type: "envelope", text, payload: text });
    store.recordEnvelope(envelope, decodeEnvelope(text, id));
    return envelope;
  };
  const child = capture("child", {
    trace_id: "trace",
    span_id: "query",
    parent_span_id: "root",
    name: "SELECT 1",
    start_timestamp: 1.1,
    end_timestamp: 1.2,
    attributes: { "sentry.op": { type: "string", value: "db" } },
  });
  capture("parent", {
    trace_id: "trace",
    span_id: "root",
    name: "GET /orders",
    is_segment: true,
    start_timestamp: 1,
    end_timestamp: 2,
  });
  await store.drain();
  expect(store.getSnapshot().traceGroups[0]).toMatchObject({
    title: "GET /orders",
    durationMs: 1000,
    roots: [{ id: "root", children: [{ id: "query", durationMs: 100 }] }],
  });
  expect(store.getSnapshot().envelopes[0]).toBe(child);
  expect(
    store
      .getSnapshot()
      .traceGroups[0]?.spans.find((span) => span.id === "query")?.payload,
  ).toEqual(JSON.parse(child.text)[1][0][1].items[0]);

  // A retained parent must not keep spans from an evicted child envelope.
  const raw = item({
    id: "opaque",
    type: "envelope",
    text: '[{},[[{"type":"attachment","filename":"raw.txt"},"unmodified"]]]',
  });
  store.recordEnvelope(raw, decodeEnvelope(raw.text, raw.id));
  await store.drain();
  expect(
    store.getSnapshot().traceGroups[0]?.spans.map((span) => span.id),
  ).toEqual(["root"]);
  expect(store.getSnapshot().attachments[0]?.payload).toBe("unmodified");
});

test("clearing invalidates queued processing from the previous capture", async () => {
  const store = createLocalTelemetryStore();
  const text = JSON.stringify([
    {},
    [
      [
        { type: "transaction" },
        {
          event_id: "old",
          type: "transaction",
          transaction: "old capture",
          start_timestamp: 1,
          timestamp: 2,
          contexts: { trace: { trace_id: "old", span_id: "root" } },
        },
      ],
    ],
  ]);
  store.recordEnvelope(
    item({ id: "old", type: "envelope", text }),
    decodeEnvelope(text, "old"),
  );
  store.clear();
  await store.drain();
  await Promise.resolve();
  expect(store.getSnapshot().traceGroups).toEqual([]);
  expect(store.getSnapshot().items).toEqual([]);
});

test("uncorrelated transactions stay discoverable without invented trace context", async () => {
  const store = createLocalTelemetryStore();
  const text = JSON.stringify([
    {},
    [
      [
        { type: "transaction" },
        { transaction: "GET /standalone", timestamp: 2 },
      ],
    ],
  ]);
  const raw = item({ id: "standalone", type: "envelope", text });
  store.recordEnvelope(raw, decodeEnvelope(text, raw.id));
  await store.drain();
  expect(store.getSnapshot().traceGroups).toMatchObject([
    { id: "standalone:0", title: "GET /standalone", spans: [], itemCount: 1 },
  ]);
  expect(store.getSnapshot().envelopes[0]?.text).toBe(text);
  expect(store.getSnapshot().items[0]?.payload).toEqual({
    transaction: "GET /standalone",
    timestamp: 2,
  });
});
