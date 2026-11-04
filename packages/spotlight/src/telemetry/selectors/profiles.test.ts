import { expect, test } from "vitest";
import { createTelemetryStore } from "../../sdk/core.ts";

test("public profile summaries measure each thread until its own next sample", async () => {
  const client = createTelemetryStore();
  try {
    expect(
      await client.ingestEnvelope([
        {},
        [
          [
            { type: "profile" },
            {
              event_id: "profile",
              version: "1",
              timestamp: 1,
              platform: "javascript",
              transaction: {
                id: "transaction",
                trace_id: "trace-a",
                name: "test",
                active_thread_id: "main",
              },
              profile: {
                frames: [
                  { module: "app", function: "recursive" },
                  { module: "worker", function: "work" },
                  { module: "app", function: "unbounded" },
                ],
                stacks: [[0, 0], [1], [2]],
                samples: [
                  {
                    thread_id: "main",
                    stack_id: 0,
                    elapsed_since_start_ns: "0",
                  },
                  {
                    thread_id: "worker",
                    stack_id: 1,
                    elapsed_since_start_ns: "5000000",
                  },
                  {
                    thread_id: "main",
                    stack_id: 0,
                    elapsed_since_start_ns: "10000000",
                  },
                  {
                    thread_id: "main",
                    stack_id: 2,
                    elapsed_since_start_ns: "20000000",
                  },
                  {
                    thread_id: "worker",
                    stack_id: 2,
                    elapsed_since_start_ns: "35000000",
                  },
                ],
              },
            },
          ],
        ],
      ]),
    ).toMatchObject({ status: "processed" });
    expect(client.getProfileFunctionSummaries()).toEqual([
      {
        name: "app@recursive",
        totalDurationMs: 40,
        sampleCount: 4,
        traceIds: new Set(["trace-a"]),
      },
      {
        name: "worker@work",
        totalDurationMs: 30,
        sampleCount: 1,
        traceIds: new Set(["trace-a"]),
      },
    ]);
    expect(client.getProfileFunctionSummaries({ traceId: "missing" })).toEqual(
      [],
    );
  } finally {
    client.dispose();
  }
});
