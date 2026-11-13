import { expect, test } from "vitest";
import { decodeEnvelope } from "./spotlight.ts";
import { buildTraceGroups } from "./trace-model.ts";

const decode = (id: string, type: string, payload: unknown) =>
  decodeEnvelope(JSON.stringify([{}, [[{ type }, payload]]]), id)[0]!;
const transaction = () =>
  decode("event", "transaction", {
    event_id: "e",
    transaction: "request",
    start_timestamp: 1,
    timestamp: 1.1,
    contexts: {
      trace: { trace_id: "t", span_id: "root" },
      profile: { profiler_id: "p" },
    },
    spans: [
      {
        span_id: "db",
        parent_span_id: "root",
        op: "db.query",
        description: "SELECT 1",
        start_timestamp: 1.04,
        timestamp: 1.06,
      },
    ],
  });
const profile = () =>
  decode("chunk", "profile_chunk", {
    chunk_id: "c",
    profiler_id: "p",
    profile: {
      active_thread_id: "main",
      frames: [{ function: "work", in_app: true }],
      stacks: [[0]],
      samples: [1.01, 1.04, 1.09, 1.12].map((timestamp) => ({
        thread_id: "main",
        stack_id: 0,
        timestamp,
      })),
    },
  });

test("sampled functions fill observed intervals around captured work without replacing real spans", () => {
  const event = transaction(),
    chunk = profile();
  const before = JSON.stringify([event, chunk]);
  const trace = buildTraceGroups([event, chunk])[0]!;
  const sampled = trace.spans.filter(
    (span) => span.item.type === "profile_chunk",
  );
  expect(sampled.length).toBeGreaterThan(0);
  expect(trace.spans.find((span) => span.id === "db")).toMatchObject({
    parentId: "root",
    durationMs: 20,
  });
  expect(
    sampled.every(
      (span) => span.description === "work" && span.durationMs! > 0,
    ),
  ).toBe(true);
  expect(
    sampled.every(
      (span) => span.startTimestamp! >= 1 && span.endTimestamp! <= 1.1,
    ),
  ).toBe(true);
  expect(sampled.find((span) => span.startTimestamp === 1.06)).toMatchObject({
    endTimestamp: 1.1,
    durationMs: 40,
    payload: { start_timestamp: 1.06, timestamp: 1.1 },
    metadata: { durationMs: 40 },
  });
  const seen = new Set<string>();
  const pending = [...trace.roots];
  while (pending.length) {
    const span = pending.pop()!;
    expect(seen.has(span.id)).toBe(false);
    seen.add(span.id);
    pending.push(...span.children);
    for (const child of span.children) expect(child.parentId).toBe(span.id);
  }
  expect(seen.size).toBe(trace.spans.length);
  expect(JSON.stringify([event, chunk])).toBe(before);
});

test("sampled work refreshes after late chunks and is independent of envelope order", () => {
  const event = transaction(),
    chunk = profile();
  const later = decode("later", "profile_chunk", {
    profiler_id: "p",
    chunk_id: "later",
    profile: {
      frames: [{ function: "later work" }],
      stacks: [[0]],
      samples: [1.07, 1.08].map((timestamp) => ({
        thread_id: "main",
        stack_id: 0,
        timestamp,
      })),
    },
  });
  const snapshot = buildTraceGroups([event, chunk])[0]!;
  const before = snapshot.spans.length;
  const refreshed = buildTraceGroups([event, chunk, later])[0]!;
  expect(
    refreshed.spans.some((span) => span.description === "later work"),
  ).toBe(true);
  expect(buildTraceGroups([later, chunk, event])).toEqual([refreshed]);
  expect(snapshot.spans).toHaveLength(before);
  expect(
    buildTraceGroups([event])[0]!.spans.every(
      (span) => span.item.type !== "profile_chunk",
    ),
  ).toBe(true);
});

test("single samples, unrelated profilers and unobserved final tails create no sampled work", () => {
  const event = transaction(),
    chunk = profile();
  const p = chunk.payload as {
    profiler_id: string;
    profile: { samples: unknown[] };
  };
  p.profile.samples = [{ thread_id: "main", stack_id: 0, timestamp: 1.01 }];
  expect(buildTraceGroups([event, chunk])[0]!.spans).toHaveLength(2);
  p.profiler_id = "unrelated";
  expect(buildTraceGroups([event, chunk])[0]!.spans).toHaveLength(2);
});

test("legacy relative profile samples attach using the matching transaction start and active thread", () => {
  const event = transaction();
  const legacy = decode("legacy", "profile", {
    transaction: { id: "e", trace_id: "t", active_thread_id: "main" },
    profile: {
      frames: [{ function: "legacy work" }],
      stacks: [[0]],
      samples: ["10000000", "30000000"].map((elapsed_since_start_ns) => ({
        thread_id: "main",
        stack_id: 0,
        elapsed_since_start_ns,
      })),
    },
  });
  const sampled = buildTraceGroups([event, legacy])[0]!.spans.filter(
    (span) => span.item.type === "profile",
  );
  expect(sampled).toHaveLength(1);
  expect(sampled[0]).toMatchObject({
    description: "legacy work",
    startTimestamp: 1.01,
    endTimestamp: 1.03,
    durationMs: 20,
    parentId: "root",
  });
});

test("missing chunks cannot project sampled work into an entirely unobserved trace", () => {
  const event = decode("event", "transaction", {
    transaction: "gap",
    start_timestamp: 5,
    timestamp: 6,
    contexts: {
      trace: { trace_id: "t", span_id: "root" },
      profile: { profiler_id: "p" },
    },
  });
  const chunks = [1, 10].map((start, index) =>
    decode(String(index), "profile_chunk", {
      profiler_id: "p",
      chunk_id: String(index),
      profile: {
        frames: [{ function: "unobserved" }],
        stacks: [[0]],
        samples: [start, start + 0.01].map((timestamp) => ({
          timestamp,
          thread_id: "main",
          stack_id: 0,
        })),
      },
    }),
  );
  expect(buildTraceGroups([event, ...chunks])[0]!.spans).toHaveLength(1);
});

test("parallel branches remain ambiguous even when one has a deeper captured child", () => {
  const event = decode("event", "transaction", {
    transaction: "parallel",
    start_timestamp: 1,
    timestamp: 10,
    contexts: {
      trace: { trace_id: "t", span_id: "root" },
      profile: { profiler_id: "p" },
    },
    spans: [
      {
        span_id: "a",
        parent_span_id: "root",
        start_timestamp: 1,
        timestamp: 10,
      },
      {
        span_id: "b",
        parent_span_id: "root",
        start_timestamp: 2,
        timestamp: 8,
      },
      { span_id: "a1", parent_span_id: "a", start_timestamp: 3, timestamp: 7 },
    ],
  });
  const chunk = decode("chunk", "profile_chunk", {
    profiler_id: "p",
    profile: {
      frames: [{ function: "ambiguous" }],
      stacks: [[0]],
      samples: [4, 5].map((timestamp) => ({
        timestamp,
        stack_id: 0,
        thread_id: "main",
      })),
    },
  });
  expect(buildTraceGroups([event, chunk])[0]!.spans).toHaveLength(4);
});

test("large continuous profiles are projected only into each trace's captured time window", () => {
  const events = Array.from({ length: 500 }, (_, index) =>
    decode(`event-${index}`, "transaction", {
      transaction: `request-${index}`,
      start_timestamp: 1 + index,
      timestamp: 1.01 + index,
      contexts: {
        trace: { trace_id: `trace-${index}`, span_id: `root-${index}` },
        profile: { profiler_id: "p" },
      },
    }),
  );
  const chunk = decode("chunk", "profile_chunk", {
    profiler_id: "p",
    profile: {
      frames: [{ function: "work" }],
      stacks: [[0]],
      samples: Array.from({ length: 100_000 }, (_, index) => ({
        timestamp: 1 + index / 100,
        thread_id: "main",
        stack_id: 0,
      })),
    },
  });
  const start = performance.now();
  const traces = buildTraceGroups([...events, chunk]);
  expect(traces).toHaveLength(500);
  expect(
    traces.every((trace) => trace.spans.some((span) => span.sampled)),
  ).toBe(true);
  expect(performance.now() - start).toBeLessThan(15000);
}, 20000);

test("sampled span output is bounded while all captured spans remain present", () => {
  const event = decode("event", "transaction", {
    transaction: "many samples",
    start_timestamp: 1,
    timestamp: 2,
    contexts: {
      trace: { trace_id: "t", span_id: "root" },
      profile: { profiler_id: "p" },
    },
  });
  const chunk = decode("chunk", "profile_chunk", {
    profiler_id: "p",
    profile: {
      frames: [{ function: "a" }, { function: "b" }],
      stacks: [[0], [1]],
      samples: Array.from({ length: 6000 }, (_, index) => ({
        timestamp: 1 + index / 6000,
        stack_id: index % 2,
        thread_id: "main",
      })),
    },
  });
  const trace = buildTraceGroups([event, chunk])[0]!;
  expect(trace.profileSpansTruncated).toBe(true);
  expect(trace.spans.filter((span) => span.sampled)).toHaveLength(5000);
  expect(trace.spans.find((span) => span.id === "root")).toBeDefined();
  expect(
    trace.spans.every(
      (span, index, all) =>
        index === 0 || span.startTimestamp! >= all[index - 1]!.startTimestamp!,
    ),
  ).toBe(true);
});

test("adjacent sampled work retains the raw chunk that actually observed each interval", () => {
  const event = transaction();
  const chunks = [1.01, 1.02].map((start, index) =>
    decode(`chunk-${index}`, "profile_chunk", {
      profiler_id: "p",
      chunk_id: String(index),
      profile: {
        frames: [{ function: "same" }],
        stacks: [[0]],
        samples: [start, start + 0.01].map((timestamp) => ({
          timestamp,
          stack_id: 0,
          thread_id: "main",
        })),
      },
    }),
  );
  const sampled = buildTraceGroups([event, ...chunks])[0]!.spans.filter(
    (span) => span.sampled,
  );
  expect(sampled).toHaveLength(2);
  expect(sampled.map((span) => span.item.id)).toEqual(
    chunks.map((item) => item.id),
  );
  expect(sampled.map((span) => span.durationMs)).toEqual([10, 10]);
});

test("legacy profiles use the matched transaction start rather than the first transaction in a trace", () => {
  const events = [1, 2].map((start, index) =>
    decode(`event-${index}`, "transaction", {
      event_id: `event-${index}`,
      transaction: `request-${index}`,
      start_timestamp: start,
      timestamp: start + 0.1,
      contexts: { trace: { trace_id: "t", span_id: `root-${index}` } },
    }),
  );
  const legacy = decode("legacy", "profile", {
    timestamp: 2,
    transaction: {
      id: "event-1",
      trace_id: "t",
      relative_start_ns: "0",
      active_thread_id: "main",
    },
    profile: {
      frames: [{ function: "second request work" }],
      stacks: [[0]],
      samples: ["10000000", "30000000"].map((elapsed_since_start_ns) => ({
        thread_id: "main",
        stack_id: 0,
        elapsed_since_start_ns,
      })),
    },
  });
  const sampled = buildTraceGroups([...events, legacy])[0]!.spans.filter(
    (span) => span.sampled,
  );
  expect(sampled).toHaveLength(1);
  expect(sampled[0]).toMatchObject({
    parentId: "root-1",
    startTimestamp: 2.01,
    endTimestamp: 2.03,
  });
});

test.each([undefined, 1.9, "1970-01-01T00:00:01.900Z"])(
  "legacy profile sample clocks use profile start and transaction-relative offsets (timestamp: %s)",
  (timestamp) => {
    const event = decode("event", "transaction", {
      event_id: "e",
      transaction: "request",
      start_timestamp: 2,
      timestamp: 2.1,
      contexts: { trace: { trace_id: "t", span_id: "root" } },
    });
    const legacy = decode("legacy", "profile", {
      timestamp,
      transaction: {
        id: "e",
        trace_id: "t",
        relative_start_ns: "100000000",
        active_thread_id: "main",
      },
      profile: {
        frames: [{ function: "work" }],
        stacks: [[0]],
        samples: ["110000000", "130000000"].map((elapsed_since_start_ns) => ({
          elapsed_since_start_ns,
          thread_id: "main",
          stack_id: 0,
        })),
      },
    });
    const sampled = buildTraceGroups([event, legacy])[0]!.spans.filter(
      (span) => span.sampled,
    );
    expect(sampled).toHaveLength(1);
    expect(sampled[0]).toMatchObject({
      startTimestamp: 2.01,
      endTimestamp: 2.03,
      parentId: "root",
    });
  },
);
