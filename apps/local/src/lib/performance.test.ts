import { expect, test } from "vitest";
import { decodeEnvelope } from "./spotlight.ts";
import { buildTraceGroups } from "./trace-model.ts";
import { spanInsights, webVitalPages } from "./performance.ts";
import { parseProfile, profileMatchesTrace } from "./profiles.ts";
const decode = (type: string, payload: unknown) =>
  decodeEnvelope(JSON.stringify([{}, [[{ type }, payload]]]), "fixture")[0]!;
test("query analysis groups embedded and standalone executions without counting a copied span twice", () => {
  const transaction = decode("transaction", {
    transaction: "GET /orders",
    start_timestamp: 1,
    timestamp: 2,
    contexts: { trace: { trace_id: "t", span_id: "root" } },
    spans: [
      {
        span_id: "q1",
        op: "db.sql.query",
        description: "select * from orders",
        start_timestamp: 1,
        timestamp: 1.1,
      },
    ],
  });
  const copy = decode("span", {
    trace_id: "t",
    span_id: "q1",
    op: "db.sql.query",
    description: "select * from orders",
    start_timestamp: 1,
    timestamp: 1.1,
  });
  const [group] = spanInsights(
    buildTraceGroups([transaction, copy]),
    "queries",
  );
  expect(group).toMatchObject({ count: 1, averageMs: 100, totalMs: 100 });
  expect(group?.executions[0]).toMatchObject({
    traceId: "t",
    span: { id: "q1" },
  });
});
test("Web Vitals retain per-visit units and classify thresholds instead of inventing missing measurements", () => {
  const [page] = webVitalPages([
    decode("transaction", {
      transaction: "/orders",
      contexts: { trace: { op: "pageload", trace_id: "t" } },
      measurements: {
        lcp: { value: 3200, unit: "millisecond" },
        cls: { value: 0.05, unit: "none" },
      },
    }),
  ]);
  expect(page?.visits[0]?.metrics).toMatchObject({
    lcp: { value: 3200, rating: "Needs improvement" },
    cls: { value: 0.05, rating: "Good" },
  });
  expect(page?.visits[0]?.metrics.inp).toBeUndefined();
});
test("profiles build root-first trees, inclusive/self samples, and interval times per thread", () => {
  const payload = {
    profile: {
      frames: [{ function: "main" }, { function: "query" }],
      stacks: [[1, 0], [0]],
      samples: [
        { thread_id: "main", stack_id: 0, elapsed_since_start_ns: "0" },
        { thread_id: "main", stack_id: 1, elapsed_since_start_ns: "10000000" },
        { thread_id: "worker", stack_id: 0, elapsed_since_start_ns: "0" },
      ],
    },
  };
  const profile = parseProfile(decode("profile", payload), "main");
  expect(profile.sampleCount).toBe(2);
  expect(profile.root.children[0]).toMatchObject({
    name: "main",
    samples: 2,
    children: [{ name: "query", samples: 1 }],
  });
  expect(profile.functions.find((fn) => fn.name === "query")).toMatchObject({
    selfMs: 10,
    totalMs: 10,
  });
  expect(profile.threads).toHaveLength(2);
});
test("continuous chunks and missing samples remain honest", () => {
  const chunk = parseProfile(
    decode("profile_chunk", {
      profile: {
        frames: [{ function: "work" }],
        stacks: [[0]],
        samples: [
          { thread_id: "1", stack_id: 0, timestamp: 10 },
          { thread_id: "1", stack_id: 0, timestamp: 10.02 },
        ],
      },
    }),
  );
  expect(chunk.durationMs).toBeCloseTo(20);
  expect(parseProfile(decode("profile", {})).sampleCount).toBe(0);
});

test("profiles require captured IDs before associating standalone spans or logs", () => {
  const chunk = decode("profile_chunk", {
    profiler_id: "unrelated",
    profile: { samples: [{ timestamp: 1000 }] },
  });
  for (const item of [
    decode("span", {
      trace_id: "other",
      span_id: "span",
      start_timestamp: 1,
      timestamp: 2,
    }),
    decode("log", { trace_id: "other", timestamp: 1, body: "Unrelated log" }),
  ]) {
    expect(profileMatchesTrace(chunk, buildTraceGroups([item])[0]!)).toBe(
      false,
    );
  }
});

test("legacy and continuous profiles retain real transaction associations", () => {
  const transaction = decode("transaction", {
    event_id: "event",
    start_timestamp: 1,
    timestamp: 2,
    contexts: {
      trace: { trace_id: "t", span_id: "s" },
      profile: { profiler_id: "profiler", profile_id: "legacy" },
    },
  });
  const trace = buildTraceGroups([transaction])[0]!;
  for (const payload of [
    { transaction: { id: "event" } },
    { transactions: [{ trace_id: "t" }] },
    { event_id: "legacy" },
    { profiler_id: "profiler", profile: { samples: [{ timestamp: 1.5 }] } },
  ])
    expect(profileMatchesTrace(decode("profile", payload), trace)).toBe(true);
  expect(
    profileMatchesTrace(
      decode("profile_chunk", {
        profiler_id: "profiler",
        profile: { samples: [{ timestamp: 3 }] },
      }),
      trace,
    ),
  ).toBe(false);
});

test("large continuous profiles can be matched without exceeding argument limits", () => {
  const transaction = decode("transaction", {
    event_id: "event",
    start_timestamp: 1000,
    timestamp: 1001,
    contexts: {
      trace: { trace_id: "t", span_id: "s" },
      profile: { profiler_id: "profiler" },
    },
  });
  const trace = buildTraceGroups([transaction])[0]!;
  const profile = {
    samples: Array.from({ length: 150_000 }, (_, index) => ({
      timestamp: 1000 + index / 100,
      thread_id: "1",
      stack_id: 0,
    })),
  };
  expect(
    profileMatchesTrace(
      decode("profile_chunk", { profiler_id: "profiler", profile }),
      trace,
    ),
  ).toBe(true);
  expect(
    profileMatchesTrace(
      decode("profile_chunk", { profiler_id: "unrelated", profile }),
      trace,
    ),
  ).toBe(false);
});
