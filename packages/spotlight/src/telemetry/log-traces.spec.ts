import { expect, test } from "vitest";
import { createTelemetryStore } from "./index.ts";

test("log batches initialize traces from each item's trace ID and normalized timestamp", async () => {
  const store = createTelemetryStore();
  const envelope = [
    {},
    [
      [
        { type: "log" },
        {
          items: [
            {
              id: "one",
              trace_id: "logs",
              timestamp: 1700000001,
              body: "first",
              level: "info",
            },
            {
              id: "two",
              trace_id: "other",
              timestamp: 1700000002,
              body: "other trace",
              level: "info",
            },
            {
              id: "three",
              trace_id: "logs",
              timestamp: 1700000003,
              body: "last",
              level: "info",
            },
            {
              id: "invalid-id",
              trace_id: 123,
              timestamp: 1700000004,
              body: "invalid trace",
              level: "info",
            },
            {
              id: "invalid-time",
              trace_id: "bad-time",
              timestamp: "invalid",
              body: "invalid time",
              level: "info",
            },
          ],
        },
      ],
    ],
  ];
  const raw = structuredClone(envelope);
  await store.ingestEnvelope(envelope);
  expect(store.getTrace("logs")).toMatchObject({
    trace_id: "logs",
    start_timestamp: 1700000001000,
    timestamp: 1700000003000,
    spanTree: [],
    transactions: [],
  });
  expect(store.getTrace("logs")?.spans.size).toBe(0);
  expect(
    store
      .getTraces()
      .map((trace) => trace.trace_id)
      .sort(),
  ).toEqual(["logs", "other"]);
  expect(store.getLogs({ traceId: "logs" })).toHaveLength(2);
  expect(envelope).toEqual(raw);

  await store.ingestEnvelope([
    {},
    [
      [
        { type: "span" },
        {
          version: 2,
          items: [
            {
              trace_id: "logs",
              span_id: "root",
              is_segment: true,
              name: "GET /later",
              start_timestamp: 1700000000,
              end_timestamp: 1700000002,
            },
          ],
        },
      ],
    ],
  ]);
  expect(store.getTrace("logs")).toMatchObject({
    rootTransactionName: "GET /later",
    start_timestamp: 1700000000000,
    timestamp: 1700000003000,
  });
  expect(store.getTrace("logs")?.spans.size).toBe(1);
  store.dispose();
});
