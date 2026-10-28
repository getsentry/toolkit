// @vitest-environment node
import { expect, test } from "vitest";
import { SDK_CAPABILITIES } from "./capabilities.ts";
import { serializeSnapshot, serializeTrace } from "./serialization.ts";
import type { Span, Trace } from "./types.ts";
function cyclicTrace(): Trace {
  const parent: Span = {
    span_id: "parent",
    start_timestamp: 1,
    timestamp: 3,
    data: {
      flags: new Set(["one", "two"]),
      entries: new Map([["key", "value"]]),
    },
  };
  const child: Span = { span_id: "child", start_timestamp: 2, timestamp: 3 };
  parent.children = [child];
  child.children = [parent];
  return {
    trace_id: "trace",
    transactions: [],
    errors: 0,
    start_timestamp: 1,
    timestamp: 3,
    rootTransaction: null,
    rootTransactionName: "",
    spans: new Map([["parent", parent]]),
    spanTree: [parent],
    profileGrafted: false,
  };
}
test("trace JSON retains cyclic children once with child IDs", () => {
  const dto = JSON.parse(JSON.stringify(serializeTrace(cyclicTrace())));
  expect(dto.schemaVersion).toBe(1);
  expect(dto.spanTree).toEqual(["parent"]);
  expect(dto.spans.map(([id]: [string]) => id)).toEqual(["parent", "child"]);
  expect(dto.spans[0][1]).toMatchObject({
    span_id: "parent",
    childSpanIds: ["child"],
    data: { flags: ["one", "two"], entries: [["key", "value"]] },
  });
  expect(dto.spans[1][1].childSpanIds).toEqual(["parent"]);
  expect(dto.spans[0][1]).not.toHaveProperty("children");
});
test("snapshot round trips plain JSON maps and profile data", () => {
  const dto = serializeSnapshot({
    revision: 4,
    envelopes: [],
    events: [],
    traces: [cyclicTrace()],
    logs: [],
    sdks: [],
    profiles: new Map([
      [
        "trace",
        {
          timestamp: 3,
          active_thread_id: "main",
          samples: [],
          stacks: [],
          frames: [],
        },
      ],
    ]),
  });
  expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
  expect(dto).toMatchObject({
    schemaVersion: 1,
    revision: 4,
    profiles: [["trace", { active_thread_id: "main" }]],
  });
});
test("capabilities expose immutable supported formats", () => {
  expect(SDK_CAPABILITIES).toMatchObject({
    schemaVersion: 1,
    spanFormats: ["legacy", "v2"],
    profileFormats: ["v1", "v2"],
  });
  expect(() =>
    (SDK_CAPABILITIES.itemTypes as unknown as string[]).push("future"),
  ).toThrow();
});

test("span tree and transaction copies merge their child references without dropping descendants", () => {
  const trace = cyclicTrace();
  const parent = trace.spans.get("parent")!;
  const transaction = {
    event_id: "transaction",
    type: "transaction" as const,
    timestamp: 3,
    start_timestamp: 1,
    contexts: { trace: { trace_id: "trace", span_id: "root" } },
    spans: [{ ...parent, children: undefined }],
  };
  trace.transactions.push(transaction);
  parent.transaction = transaction;
  const dto = serializeTrace(trace);
  expect(dto.spans).toHaveLength(2);
  expect(dto.spans[0][1]).toMatchObject({
    childSpanIds: ["child"],
    transactionEventId: "transaction",
  });
  expect(dto.transactions).toMatchObject([
    { event_id: "transaction", spanIds: ["parent"] },
  ]);
});

test("valid continuous profiles and streamed plus legacy traces serialize", async () => {
  const { readFileSync } = await import("node:fs");
  const { createTelemetryPipeline } = await import("../sdk/node.ts");
  const pipeline = createTelemetryPipeline();
  try {
    for (const file of [
      "continuous_profiling/transaction.txt",
      "continuous_profiling/profile_chunk_1.txt",
      "envelope_span_v2.txt",
    ]) {
      const receipt = await pipeline.ingestPayload({
        body: readFileSync(new URL(`../../_fixtures/${file}`, import.meta.url)),
        contentType: "application/x-sentry-envelope",
      });
      expect(receipt.status).toBe("processed");
    }
    const dto = serializeSnapshot(pipeline.getSnapshot());
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
    expect(dto.traces.length).toBeGreaterThan(0);
    for (const trace of dto.traces)
      expect(trace.spans.length).toBeGreaterThan(0);
  } finally {
    pipeline.dispose();
  }
});

test("a wide span graph does not use call-argument expansion", () => {
  const trace = cyclicTrace();
  const parent = trace.spans.get("parent")!;
  parent.children = Array.from({ length: 130000 }, (_, index) => ({
    span_id: `child-${index}`,
    start_timestamp: 2,
    timestamp: 3,
  }));
  const dto = serializeTrace(trace);
  expect(dto.spans).toHaveLength(130001);
  expect(dto.spans[0][1].childSpanIds).toHaveLength(130000);
});

test("canonical spans serialize after streamed updates supersede transaction span copies", async () => {
  const { createTelemetryStore } = await import("./index.ts");
  const client = createTelemetryStore();
  try {
    expect(
      (
        await client.ingestEnvelope([
          {},
          [
            [
              { type: "transaction" },
              {
                event_id: "old",
                type: "transaction",
                start_timestamp: 1,
                timestamp: 2,
                contexts: { trace: { trace_id: "mixed", span_id: "root" } },
                spans: [
                  {
                    span_id: "child",
                    parent_span_id: "root",
                    start_timestamp: 1.1,
                    timestamp: 1.2,
                    description: "old",
                  },
                ],
              },
            ],
          ],
        ])
      ).status,
    ).toBe("processed");
    expect(
      (
        await client.ingestEnvelope([
          {},
          [
            [
              { type: "span" },
              {
                version: 2,
                items: [
                  {
                    trace_id: "mixed",
                    span_id: "child",
                    parent_span_id: "root",
                    start_timestamp: 1.1,
                    end_timestamp: 1.3,
                    name: "updated",
                  },
                ],
              },
            ],
          ],
        ])
      ).status,
    ).toBe("processed");
    const dto = serializeTrace(client.getTrace("mixed")!);
    expect(dto.spans.find(([id]) => id === "child")?.[1]).toMatchObject({
      description: "updated",
      timestamp: 1300,
    });
  } finally {
    client.dispose();
  }
});

test("summary JSON converts profile trace ID sets to arrays", async () => {
  const { getProfileFunctionSummaries } =
    await import("./selectors/profiles.ts");
  const { serializeSummaries } = await import("./serialization.ts");
  const summaries = getProfileFunctionSummaries(
    new Map([
      [
        "trace-one",
        {
          samples: [
            { start_timestamp: 0, stack_id: 0, thread_id: "main" },
            { start_timestamp: 10, stack_id: 0, thread_id: "main" },
          ],
          stacks: [[0]],
          frames: [{ function: "work" }],
        },
      ],
    ]),
  );
  const dto = serializeSummaries(summaries);
  expect(dto).toEqual({
    schemaVersion: 1,
    summaries: [
      {
        name: "<unknown>@work",
        totalDurationMs: 10,
        sampleCount: 1,
        traceIds: ["trace-one"],
      },
    ],
  });
  expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
  expect(() =>
    serializeSummaries([
      {
        description: "query",
        count: 1,
        totalDurationMs: 1,
        averageDurationMs: 1,
        spans: [],
      },
    ] as never),
  ).toThrow(TypeError);
});
