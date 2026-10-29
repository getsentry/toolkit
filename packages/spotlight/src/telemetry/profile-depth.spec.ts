import { expect, test } from "vitest";
import { createTelemetryStore, serializeTrace } from "../sdk/core.ts";

const depth = 12000;

function transaction(spans: unknown[] = []) {
  return [
    { type: "transaction" },
    {
      event_id: "transaction",
      type: "transaction",
      transaction: "deep profile",
      start_timestamp: 1,
      timestamp: 2,
      contexts: { trace: { trace_id: "trace", span_id: "root" } },
      spans,
    },
  ];
}

function profile(frameCount: number) {
  return [
    { type: "profile" },
    {
      event_id: "profile",
      version: "1",
      timestamp: 1,
      platform: "javascript",
      transaction: { trace_id: "trace", active_thread_id: "main" },
      profile: {
        frames: Array.from({ length: frameCount }, (_, index) => ({
          module: "app",
          function: `frame-${index}`,
        })),
        stacks: [
          Array.from(
            { length: frameCount },
            (_, index) => frameCount - index - 1,
          ),
        ],
        samples: [
          {
            thread_id: "main",
            stack_id: 0,
            elapsed_since_start_ns: "100000000",
          },
          {
            thread_id: "main",
            stack_id: 0,
            elapsed_since_start_ns: "200000000",
          },
        ],
      },
    },
  ];
}

test("public ingestion retains and deterministically consolidates a 12000-frame profile stack", async () => {
  const store = createTelemetryStore();
  try {
    const input = [{}, [transaction(), profile(depth)]];
    expect((await store.ingestEnvelope(input)).status).toBe("processed");
    expect(store.getProfile("trace")?.frames).toHaveLength(depth);
    const trace = store.getTrace("trace")!;
    const derived = [...trace.spans.values()].filter(
      (span) => span.tags?.source === "profile",
    );
    expect(derived.filter((span) => span.op !== "Thread")).toHaveLength(depth);
    let current = trace.spans.get("root")?.children?.[0];
    for (let index = 0; index < depth; index++) {
      expect(current?.op).toBe(`frame-${index}`);
      expect(current?.start_timestamp).toBe(1100);
      expect(current?.timestamp).toBe(2000);
      current = current?.children?.[0];
    }
    expect(current).toBeUndefined();
    const serialized = JSON.parse(
      JSON.stringify(serializeTrace(trace)),
    ) as ReturnType<typeof serializeTrace>;
    const spans = new Map(serialized.spans);
    expect(spans.size).toBe(depth + 1);
    for (const [id, span] of spans) {
      for (const childId of span.childSpanIds) {
        expect(spans.get(childId)?.parent_span_id).toBe(id);
      }
      if (id !== "root") {
        expect(
          spans.get(span.parent_span_id as string)?.childSpanIds,
        ).toContain(id);
      }
    }
    const identities = [...trace.spans.keys()];
    store.reset();
    expect((await store.ingestEnvelope(input)).status).toBe("processed");
    expect([...store.getTrace("trace")!.spans.keys()]).toEqual(identities);
  } finally {
    store.dispose();
  }
});

test("public ingestion grafts profile frames below a 12000-span real chain", async () => {
  const store = createTelemetryStore();
  try {
    const spans = Array.from({ length: depth }, (_, index) => ({
      span_id: `real-${index}`,
      parent_span_id: index === 0 ? "root" : `real-${index - 1}`,
      op: "function",
      description: `real-${index}`,
      start_timestamp: 1,
      timestamp: 2,
    }));
    expect(
      (await store.ingestEnvelope([{}, [transaction(spans), profile(1)]]))
        .status,
    ).toBe("processed");
    expect(store.getProfile("trace")?.frames).toHaveLength(1);
    const trace = store.getTrace("trace")!;
    expect(trace.spans.get(`real-${depth - 1}`)?.children).toMatchObject([
      { op: "frame-0", start_timestamp: 1100, timestamp: 2000 },
    ]);
    expect(
      [...trace.spans.values()].filter(
        (span) => span.tags?.source !== "profile",
      ),
    ).toHaveLength(depth + 1);
    expect(trace.spans.get("root")?.transaction).toBe(trace.transactions[0]);
  } finally {
    store.dispose();
  }
});
