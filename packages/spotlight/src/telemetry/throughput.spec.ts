import { expect, test } from "vitest";
import { createTelemetryPipeline } from "../sdk/node.ts";
import type { SentryEnvelope } from "../sdk/core.ts";
import { createTelemetryStore } from "./index.ts";

function transaction(
  index: number,
  traceId = `trace-${index}`,
): SentryEnvelope {
  return [
    { sdk: { name: "sentry.javascript.node", version: "10.63.0" } },
    [
      [
        { type: "transaction" },
        {
          event_id: `event-${index}`,
          type: "transaction",
          transaction: `/requests/${index}`,
          start_timestamp: index + 1,
          timestamp: index + 2,
          contexts: { trace: { trace_id: traceId, span_id: `root-${index}` } },
          spans: Array.from({ length: 20 }, (_, child) => ({
            span_id: `child-${index}-${child}`,
            parent_span_id: `root-${index}`,
            op: "db.query",
            description: "SELECT * FROM users WHERE id = ?",
            start_timestamp: index + 1 + child / 100,
            timestamp: index + 1.01 + child / 100,
            data: { "db.system": "postgresql" },
          })),
        },
      ],
    ],
  ];
}

// The receiver awaits each envelope before admitting the next one. This broad
// budget catches full-history replay/deep-copy work without depending on a
// particular processor or a narrow per-operation microbenchmark threshold.
test.each(["receiver", "subscribed reader"])(
  "%s processes 1,000 21-span envelopes across default retention within 15 seconds",
  async (mode) => {
    const store =
      mode === "receiver" ? createTelemetryPipeline() : createTelemetryStore();
    let notifications = 0;
    if (mode === "subscribed reader")
      store.subscribe((snapshot) => {
        expect(snapshot).toBe(store.getSnapshot());
        expect(snapshot.traces.length).toBeLessThanOrEqual(500);
        expect(snapshot.events.length).toBeLessThanOrEqual(500);
        expect(snapshot.envelopes.length).toBeLessThanOrEqual(500);
        expect(snapshot.sdks).toHaveLength(1);
        expect(snapshot.profiles.size).toBe(0);
        expect(snapshot.logs).toHaveLength(0);
        // Browser adapters inspect trace span collections on each notification.
        expect(snapshot.traces.at(-1)?.spans.size).toBe(21);
        notifications++;
      });
    const started = performance.now();
    try {
      for (let index = 0; index < 1000; index++) {
        const input = transaction(index);
        const result =
          "ingestPayload" in store
            ? await store.ingestPayload({
                body:
                  [
                    JSON.stringify(input[0]),
                    ...input[1].flatMap(([header, payload]) => [
                      JSON.stringify(header),
                      JSON.stringify(payload),
                    ]),
                  ].join("\n") + "\n",
              })
            : await store.ingestEnvelope(input);
        expect(result.status).toBe("processed");
        if (index % 100 === 99)
          expect(performance.now() - started).toBeLessThan(15000);
      }
      expect(store.getStats().retainedEnvelopes).toBe(500);
      expect(store.getEvents()).toHaveLength(500);
      expect(store.getTrace("trace-0")).toBeUndefined();
      expect(store.getTrace("trace-999")?.spans.size).toBe(21);
      if (mode === "subscribed reader") expect(notifications).toBe(1000);
    } finally {
      store.dispose();
    }
  },
  20000,
);

test("untouched trace graphs are shared while historical snapshots remain isolated, even when read late", async () => {
  const store = createTelemetryStore();
  try {
    await store.ingestEnvelope(transaction(1));
    const unread = store.getSnapshot();
    await store.ingestEnvelope(transaction(2));
    const first = store.getTrace("trace-1")!;
    await store.ingestEnvelope(transaction(3, "trace-2"));
    expect(store.getTrace("trace-1")).toBe(first);
    const previous = store.getSnapshot();
    await store.ingestEnvelope(transaction(4, "trace-1"));
    expect(unread.traces).toHaveLength(1);
    expect(unread.traces[0].spans.size).toBe(21);
    expect(previous.traces.find((trace) => trace.trace_id === "trace-1")).toBe(
      first,
    );
    expect(first.spans.size).toBe(21);
    expect(store.getTrace("trace-1")?.spans.size).toBe(42);
    expect(Reflect.set(first, "errors", 100)).toBe(false);
    expect(first.errors).toBe(0);
  } finally {
    store.dispose();
  }
});

// High limits must not re-copy every retained span on publication.
test("a subscribed reader retains 1,600 21-span envelopes at a 50,000 limit within 15 seconds", async () => {
  const store = createTelemetryStore({ retention: { maxEnvelopes: 50000 } });
  let notifications = 0;
  store.subscribe((snapshot) => {
    expect(snapshot.traces.at(-1)?.spans.size).toBe(21);
    expect(snapshot.envelopes.length).toBe(snapshot.events.length);
    notifications++;
  });
  const started = performance.now();
  try {
    for (let index = 0; index < 1600; index++) {
      expect(
        (await store.ingestEnvelope(transaction(index))).counts.spans,
      ).toBe(21);
      if (index % 100 === 99)
        expect(performance.now() - started).toBeLessThan(15000);
    }
    expect(store.getTraces()).toHaveLength(1600);
    expect(store.getStats().retainedEnvelopes).toBe(1600);
    expect(notifications).toBe(1600);
  } finally {
    store.dispose();
  }
}, 20000);

test("a subscribed reader assembles 2,000 streamed deliveries across default retention within 15 seconds", async () => {
  const store = createTelemetryStore();
  let notifications = 0;
  store.subscribe((snapshot) => {
    expect(snapshot.traces.length).toBeLessThanOrEqual(25);
    expect(snapshot.events.length).toBeLessThanOrEqual(500);
    notifications++;
  });
  const started = performance.now();
  try {
    for (let index = 0; index < 2000; index++) {
      const first = Math.floor(index / 21) * 21;
      const result = await store.ingestEnvelope([
        {},
        [
          [
            { type: "span" },
            {
              version: 2,
              items: [
                {
                  trace_id: `trace-${first}`,
                  span_id: `span-${index}`,
                  parent_span_id: index === first ? undefined : `span-${first}`,
                  is_segment: index === first,
                  name: "streamed request",
                  start_timestamp: 1,
                  end_timestamp: 2,
                },
              ],
            },
          ],
        ],
      ]);
      expect(result.status).toBe("processed");
      if (index % 100 === 99)
        expect(performance.now() - started).toBeLessThan(15000);
    }
    expect(store.getEvents()).toHaveLength(500);
    expect(store.getStats().retainedEnvelopes).toBe(500);
    expect(store.getTrace("trace-0")).toBeUndefined();
    expect(store.getTrace("trace-1995")?.spans.size).toBe(5);
    expect(notifications).toBe(2000);
  } finally {
    store.dispose();
  }
}, 20000);
