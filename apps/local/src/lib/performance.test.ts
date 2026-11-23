import { expect, test } from "vitest";
import { decodeEnvelope } from "./spotlight.ts";
import { buildTraceGroups } from "./trace-model.ts";
import { spanInsights, webVitalPages } from "./performance.ts";
import { parseProfile, profileMatchesTrace } from "./profiles.ts";
import {
  resource,
  spanEnvelope,
  streamedPageloadSpans,
  streamedWebVitalSpans,
} from "../test-fixtures/streamed-pageload.ts";
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

test.each(["queries", "resources"] as const)(
  "%s summaries normalize blank and padded names without combining operations",
  (kind) => {
    const operation = kind === "queries" ? "db.query" : "resource.script";
    const items = decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "span" },
            {
              version: 2,
              items: [undefined, "   ", " SELECT 1 ", "SELECT 1"].map(
                (name, index) => ({
                  trace_id: "labels",
                  span_id: String(index),
                  name,
                  start_timestamp: index,
                  end_timestamp: index + 0.1,
                  attributes: { "sentry.op": { value: operation } },
                }),
              ),
            },
          ],
        ],
      ]),
      "labels",
    );
    const summaries = spanInsights(buildTraceGroups(items), kind);
    expect(summaries.map(({ name, count }) => ({ name, count }))).toEqual([
      { name: operation, count: 2 },
      { name: "SELECT 1", count: 2 },
    ]);
    expect(summaries[1]?.executions[0]?.span.payload).toMatchObject({
      name: " SELECT 1 ",
    });
  },
);

test("resource sizes skip invalid aliases before using captured nonnegative sizes", () => {
  const items = decodeEnvelope(
    JSON.stringify([
      {},
      [
        [
          { type: "span" },
          {
            version: 2,
            items: [
              {
                "http.response_content_length": -1,
                "http.response.body.size": 200,
              },
              {
                "http.response_content_length": -1,
                "http.response.body.size": -2,
                "http.decoded_response_content_length": 400,
              },
              {},
            ].map((data, index) => ({
              trace_id: "sizes",
              span_id: String(index),
              name: "asset.js",
              start_timestamp: index,
              end_timestamp: index + 0.1,
              attributes: Object.fromEntries(
                Object.entries({ "sentry.op": "resource.script", ...data }).map(
                  ([key, value]) => [key, { value }],
                ),
              ),
            })),
          },
        ],
      ],
    ]),
    "sizes",
  );
  expect(spanInsights(buildTraceGroups(items), "resources")).toMatchObject([
    { count: 3, averageBytes: 300 },
  ]);
});
test("Web Vitals read streamed pageload segments and their web vital spans", () => {
  const items = [
    ...decodeEnvelope(spanEnvelope(streamedPageloadSpans), "pageload"),
    ...decodeEnvelope(spanEnvelope(streamedWebVitalSpans), "vitals"),
  ];
  const pages = webVitalPages(items);
  expect(pages.map((page) => page.name)).toEqual(["/"]);
  expect(pages[0]?.visits).toHaveLength(1);
  expect(pages[0]?.visits[0]?.item.id).toBe("pageload:0:0");
  expect(pages[0]?.visits[0]?.metrics).toEqual({
    ttfb: { value: 24.4, rating: "Good" },
    fcp: { value: 252, rating: "Good" },
    lcp: { value: 3200, rating: "Needs improvement" },
    cls: { value: 0.3, rating: "Poor" },
    inp: { value: 16, rating: "Good" },
  });
});
test("resource analysis groups streamed spans by URL instead of their host name", () => {
  const groups = spanInsights(
    buildTraceGroups(
      decodeEnvelope(spanEnvelope(streamedPageloadSpans), "pageload"),
    ),
    "resources",
  );
  expect(groups.map((group) => group.name).sort()).toEqual([
    "http://localhost:4000/app.js",
    "http://localhost:4000/js/mod1.js",
    "http://localhost:4000/style1.css",
  ]);
  expect(groups.every((group) => group.averageBytes === 1200)).toBe(true);
});
test("a later name-less update keeps the streamed resource URL label", () => {
  const [script] = streamedPageloadSpans.filter(
    (span) => span.span_id === "b5a0feefbd6a1dd8",
  );
  if (!script) throw new Error("Expected resource span");
  const { name: _name, ...update } = {
    ...script,
    end_timestamp: script.end_timestamp + 0.01,
  };
  const [group, ...rest] = spanInsights(
    buildTraceGroups([
      ...decodeEnvelope(spanEnvelope([script]), "first"),
      ...decodeEnvelope(spanEnvelope([update]), "update"),
    ]),
    "resources",
  );
  expect(rest).toEqual([]);
  expect(group?.name).toBe("http://localhost:4000/app.js");
});
test("resource labels drop cache-busting queries and fragments", () => {
  const start = 1794949298.4756;
  const groups = spanInsights(
    buildTraceGroups(
      decodeEnvelope(
        spanEnvelope([
          streamedPageloadSpans[0],
          resource(
            "e5a0feefbd6a1dd8",
            "resource.script",
            "/app.js?v=1a2b",
            start,
          ),
          resource(
            "f5a0feefbd6a1dd8",
            "resource.script",
            "/app.js?t=17",
            start,
          ),
          resource(
            "a6a0feefbd6a1dd8",
            "resource.script",
            "/app.js?token=secret#x",
            start,
          ),
        ]),
        "pageload",
      ),
    ),
    "resources",
  );
  expect(groups.map((group) => [group.name, group.count])).toEqual([
    ["http://localhost:4000/app.js", 3],
  ]);
});
test("transaction child spans named by host use their URL like span v2 items", () => {
  const transaction = decode("transaction", {
    transaction: "/orders",
    start_timestamp: 1,
    timestamp: 2,
    contexts: { trace: { trace_id: "t", span_id: "root", op: "pageload" } },
    spans: [
      {
        span_id: "r1",
        op: "resource.script",
        description: "localhost",
        start_timestamp: 1,
        timestamp: 1.1,
        data: { "url.full": "http://localhost:4000/app.js?v=1" },
      },
    ],
  });
  const [group] = spanInsights(buildTraceGroups([transaction]), "resources");
  expect(group?.name).toBe("http://localhost:4000/app.js");
});
