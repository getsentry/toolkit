import { expect, test } from "vitest";
import { createTelemetryStore } from "../sdk/core.ts";

test("public ingestion clips a profile interval at the next real span", async () => {
  const store = createTelemetryStore();
  try {
    expect(
      (
        await store.ingestEnvelope([
          {},
          [
            [
              { type: "transaction" },
              {
                event_id: "transaction",
                type: "transaction",
                transaction: "profile interval",
                start_timestamp: 1,
                timestamp: 15,
                contexts: {
                  trace: { trace_id: "trace", span_id: "root" },
                },
                spans: [
                  {
                    span_id: "left",
                    parent_span_id: "root",
                    start_timestamp: 1,
                    timestamp: 3,
                  },
                  {
                    span_id: "right",
                    parent_span_id: "root",
                    start_timestamp: 9,
                    timestamp: 15,
                  },
                ],
              },
            ],
            [
              { type: "profile" },
              {
                event_id: "profile",
                version: "1",
                timestamp: 1,
                platform: "javascript",
                transaction: {
                  trace_id: "trace",
                  active_thread_id: "main",
                },
                profile: {
                  frames: [{ module: "app", function: "work" }],
                  stacks: [[0]],
                  samples: [
                    {
                      thread_id: "main",
                      stack_id: 0,
                      elapsed_since_start_ns: "4000000000",
                    },
                    {
                      thread_id: "main",
                      stack_id: 0,
                      elapsed_since_start_ns: "12000000000",
                    },
                  ],
                },
              },
            ],
          ],
        ])
      ).status,
    ).toBe("processed");
    const trace = store.getTrace("trace")!;
    expect(trace.spans.get("root")?.children).toMatchObject([
      { span_id: "left", start_timestamp: 1000, timestamp: 3000 },
      {
        op: "work",
        start_timestamp: 5000,
        timestamp: 9000,
        tags: { source: "profile" },
      },
      {
        span_id: "right",
        start_timestamp: 9000,
        timestamp: 15000,
        children: [{ op: "work", start_timestamp: 13000, timestamp: 15000 }],
      },
    ]);
  } finally {
    store.dispose();
  }
});
