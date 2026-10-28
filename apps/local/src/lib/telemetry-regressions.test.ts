import { expect, test } from "vitest";
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
