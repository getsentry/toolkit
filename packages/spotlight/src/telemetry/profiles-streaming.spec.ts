import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { serializeTrace } from "../sdk/core.ts";
import { createTelemetryPipeline } from "../sdk/node.ts";

test("later continuous chunks refresh the public profile, summaries and grafted spans", async () => {
  const pipeline = createTelemetryPipeline();
  try {
    for (const file of ["transaction.txt", "profile_chunk_1.txt"]) {
      const result = await pipeline.ingestPayload({
        body: readFileSync(
          new URL(
            `../../_fixtures/continuous_profiling/${file}`,
            import.meta.url,
          ),
        ),
      });
      expect(result.status).toBe("processed");
    }
    const traceId = "f1e2d3c4b5a6978012345678901234ab";
    expect(pipeline.getProfile(traceId)?.samples).toHaveLength(7);
    await pipeline.ingestEnvelope([
      {},
      [
        [
          { type: "profile_chunk" },
          {
            event_id: "later-chunk",
            type: "profile_chunk",
            version: "2",
            profiler_id: "71bba98d90b545c39f2ae73f702d7ef4",
            chunk_id: "later-chunk",
            platform: "cocoa",
            profile: {
              frames: [{ module: "App", function: "laterWork" }],
              stacks: [[0]],
              samples: [
                { timestamp: 1724770811.573, stack_id: 0, thread_id: "259" },
                { timestamp: 1724770811.583, stack_id: 0, thread_id: "259" },
              ],
            },
          },
        ],
      ],
    ]);
    expect(pipeline.getProfile(traceId)?.samples).toHaveLength(9);
    expect(pipeline.getProfileFunctionSummaries({ traceId })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "App@laterWork", sampleCount: 1 }),
      ]),
    );
    expect([...pipeline.getTrace(traceId)!.spans.values()]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: "laterWork",
          tags: { source: "profile" },
        }),
      ]),
    );
  } finally {
    pipeline.dispose();
  }
});

function transaction(eventId: string, start = 1, end = 1.4) {
  return [
    { type: "transaction" },
    {
      event_id: eventId,
      type: "transaction",
      platform: "javascript",
      transaction: "streamed profile",
      start_timestamp: start,
      timestamp: end,
      contexts: {
        trace: {
          trace_id: "trace",
          span_id: "root",
          data: { "thread.id": "main" },
        },
        profile: { profiler_id: "profiler" },
      },
      spans: [
        {
          span_id: "embedded",
          parent_span_id: "root",
          description: "real work",
          start_timestamp: 1.15,
          timestamp: 1.18,
        },
      ],
    },
  ];
}

function chunk(id: string, fn: string, timestamps: number[]) {
  return [
    { type: "profile_chunk" },
    {
      event_id: id,
      type: "profile_chunk",
      version: "2",
      profiler_id: "profiler",
      chunk_id: id,
      platform: "javascript",
      profile: {
        frames: [{ module: "app", function: fn }],
        stacks: [[0]],
        samples: timestamps.map((timestamp) => ({
          timestamp,
          stack_id: 0,
          thread_id: "main",
        })),
      },
    },
  ];
}

const streamed = [
  { type: "span" },
  {
    version: 2,
    items: [
      {
        trace_id: "trace",
        span_id: "streamed",
        parent_span_id: "root",
        name: "streamed work",
        start_timestamp: 1.28,
        end_timestamp: 1.29,
      },
    ],
  },
];
const javascriptHeader = {
  sdk: { name: "sentry.javascript.node", version: "10.63.0" },
};

test("profile chunks, late timing and streamed spans converge across reordered batches without stale derived spans", async () => {
  const inputs = [
    transaction("initial"),
    chunk("first", "first", [1, 1.1]),
    chunk("second", "second", [1.2, 1.3]),
    streamed,
    transaction("timing", 0.95, 1.5),
  ];
  const baseline = createTelemetryPipeline();
  const reordered = createTelemetryPipeline();
  try {
    expect(
      (await baseline.ingestEnvelope([javascriptHeader, inputs])).status,
    ).toBe("processed");
    const expectedProfile = baseline.getProfile("trace");
    const expectedSummary = baseline.getProfileFunctionSummaries();
    const expectedTrace = serializeTrace(baseline.getTrace("trace")!);
    expectedTrace.spans.sort(([a], [b]) => a.localeCompare(b));
    for (const order of [
      [1, 2, 0, 3, 4],
      [2, 0, 3, 1, 4],
      [0, 1, 4, 3, 2],
    ]) {
      reordered.reset();
      for (const index of order) {
        expect(
          (await reordered.ingestEnvelope([javascriptHeader, [inputs[index]]]))
            .status,
        ).toBe("processed");
      }
      expect(reordered.getProfile("trace")).toEqual(expectedProfile);
      expect(reordered.getProfileFunctionSummaries()).toEqual(expectedSummary);
      const trace = reordered.getTrace("trace")!;
      const serialized = serializeTrace(trace);
      serialized.spans.sort(([a], [b]) => a.localeCompare(b));
      expect(serialized).toEqual(expectedTrace);
      expect(
        [...trace.spans.values()]
          .filter((span) => span.tags?.source !== "profile")
          .map((span) => span.span_id)
          .sort(),
      ).toEqual(["embedded", "root", "streamed"]);
      expect(trace.spans.get("root")?.transaction).toBe(trace.transactions[0]);
      const beforeReplay = serializeTrace(trace);
      expect(
        (await reordered.ingestEnvelope([javascriptHeader, [inputs[2]]]))
          .status,
      ).toBe("processed");
      expect(serializeTrace(reordered.getTrace("trace")!)).toEqual(
        beforeReplay,
      );
    }
  } finally {
    baseline.dispose();
    reordered.dispose();
  }
});

test("appending chunks preserves IDs for existing derived nodes and earlier snapshots", async () => {
  const pipeline = createTelemetryPipeline();
  try {
    await pipeline.ingestEnvelope([
      javascriptHeader,
      [transaction("initial"), chunk("first", "first", [1, 1.1])],
    ]);
    const earlier = pipeline.getTrace("trace")!;
    const previousIds = [...earlier.spans.values()]
      .filter((span) => span.op === "first" && span.start_timestamp === 1000)
      .map((span) => span.span_id);
    expect(previousIds).toHaveLength(1);
    const serializedEarlier = serializeTrace(earlier);
    await pipeline.ingestEnvelope([
      javascriptHeader,
      [chunk("second", "second", [1.2, 1.3])],
    ]);
    const latest = pipeline.getTrace("trace")!;
    expect(
      [...latest.spans.values()]
        .filter((span) => span.op === "first" && span.start_timestamp === 1000)
        .map((span) => span.span_id),
    ).toEqual(previousIds);
    expect(
      [...latest.spans.values()].some((span) => span.op === "second"),
    ).toBe(true);
    expect(serializeTrace(earlier)).toEqual(serializedEarlier);
  } finally {
    pipeline.dispose();
  }
});

test("context-only errors do not extend an existing profile graft", async () => {
  const pipeline = createTelemetryPipeline();
  try {
    await pipeline.ingestEnvelope([
      javascriptHeader,
      [transaction("initial"), chunk("first", "first", [1, 1.1])],
    ]);
    const before = [...pipeline.getTrace("trace")!.spans.values()];
    const profileBefore = pipeline.getProfile("trace");
    await pipeline.ingestEnvelope([
      javascriptHeader,
      [
        [
          { type: "event" },
          {
            event_id: "later-error",
            timestamp: 9,
            contexts: { trace: { trace_id: "trace" } },
            exception: { values: [{ type: "Error", value: "context only" }] },
          },
        ],
      ],
    ]);
    expect([...pipeline.getTrace("trace")!.spans.values()]).toEqual(before);
    expect(pipeline.getProfile("trace")).toEqual(profileBefore);
  } finally {
    pipeline.dispose();
  }
});

test("profile refresh uses real topology bounds across error and chunk ordering", async () => {
  const inputs = [
    transaction("initial"),
    chunk("first", "first", [1, 1.1]),
    [
      { type: "event" },
      {
        event_id: "later-error",
        timestamp: 9,
        contexts: { trace: { trace_id: "trace" } },
        exception: { values: [{ type: "Error", value: "context only" }] },
      },
    ],
    chunk("later", "later", [1.5, 1.6]),
  ];
  let expectedSpans: ReturnType<typeof serializeTrace>["spans"] | undefined;
  for (const order of [
    [0, 1, 2, 3],
    [0, 1, 3, 2],
    [2, 0, 1, 3],
  ]) {
    const pipeline = createTelemetryPipeline();
    try {
      for (const index of order)
        await pipeline.ingestEnvelope([javascriptHeader, [inputs[index]]]);
      const trace = pipeline.getTrace("trace")!;
      expect(trace.timestamp).toBe(9000);
      const derived = [...trace.spans.values()].filter(
        (span) => span.tags?.source === "profile",
      );
      expect(derived.some((span) => span.op === "first")).toBe(true);
      expect(derived.some((span) => span.op === "later")).toBe(false);
      expect(
        derived.every(
          (span) => span.start_timestamp >= 1000 && span.timestamp <= 1400,
        ),
      ).toBe(true);
      const serialized = serializeTrace(trace).spans.sort(([a], [b]) =>
        a.localeCompare(b),
      );
      if (expectedSpans) expect(serialized).toEqual(expectedSpans);
      else expectedSpans = serialized;

      await pipeline.ingestEnvelope([
        javascriptHeader,
        [
          [
            { type: "span" },
            {
              trace_id: "trace",
              span_id: "late-real",
              op: "function",
              start_timestamp: 1.7,
              timestamp: 1.8,
            },
          ],
        ],
      ]);
      const extended = pipeline.getTrace("trace")!;
      const refreshed = [...extended.spans.values()].filter(
        (span) => span.tags?.source === "profile",
      );
      expect(extended.timestamp).toBe(9000);
      expect(refreshed.some((span) => span.op === "later")).toBe(true);
      expect(refreshed.every((span) => span.timestamp <= 1800)).toBe(true);
      expect(extended.spans.get("root")?.transaction).toBe(
        extended.transactions[0],
      );
    } finally {
      pipeline.dispose();
    }
  }
});

test("a linked profile remains readable without grafting context-only trace time", async () => {
  const pipeline = createTelemetryPipeline();
  try {
    await pipeline.ingestEnvelope([
      javascriptHeader,
      [
        [
          { type: "event" },
          {
            event_id: "early",
            timestamp: 1,
            contexts: { trace: { trace_id: "trace" } },
          },
        ],
        [
          { type: "event" },
          {
            event_id: "late",
            timestamp: 9,
            contexts: { trace: { trace_id: "trace" } },
          },
        ],
        [
          { type: "profile" },
          {
            event_id: "profile-only",
            type: "profile",
            version: "1",
            timestamp: 1,
            platform: "javascript",
            transaction: { trace_id: "trace", active_thread_id: "main" },
            profile: {
              frames: [{ module: "app", function: "work" }],
              stacks: [[0]],
              samples: [
                { thread_id: "main", stack_id: 0, elapsed_since_start_ns: "0" },
                {
                  thread_id: "main",
                  stack_id: 0,
                  elapsed_since_start_ns: "100000000",
                },
              ],
            },
          },
        ],
      ],
    ]);
    expect(pipeline.getTrace("trace")?.timestamp).toBe(9000);
    expect(pipeline.getProfile("trace")?.samples).toHaveLength(2);
    expect(pipeline.getTrace("trace")?.spans.size).toBe(0);
    expect(pipeline.getTrace("trace")?.spanTree).toEqual([]);
  } finally {
    pipeline.dispose();
  }
});

test.each([{}, { sdk: { name: "sentry.python", version: "2.0.0" } }])(
  "explicit chunk platform survives batching with an optional or conflicting SDK header %j",
  async (header) => {
    const combined = createTelemetryPipeline();
    const split = createTelemetryPipeline();
    try {
      const txn = transaction("initial");
      delete (txn[1] as { platform?: string }).platform;
      const profileChunk = chunk("first", "first", [1, 1.1]);
      await combined.ingestEnvelope([header, [txn, profileChunk]]);
      await split.ingestEnvelope([header, [txn]]);
      await split.ingestEnvelope([header, [profileChunk]]);
      expect(combined.getProfile("trace")?.platform).toBe("javascript");
      expect(split.getProfile("trace")).toEqual(combined.getProfile("trace"));
      expect(combined.getEvent("first")?.platform).toBe("javascript");
      expect(split.getEvent("first")?.platform).toBe("javascript");
    } finally {
      combined.dispose();
      split.dispose();
    }
  },
);

test.each([undefined, null, 17, "", "  "])(
  "infers a missing or invalid chunk platform %j from the envelope SDK",
  async (platform) => {
    const pipeline = createTelemetryPipeline();
    try {
      const profileChunk = chunk("first", "first", [1, 1.1]);
      (profileChunk[1] as { platform?: unknown }).platform = platform;
      await pipeline.ingestEnvelope([
        javascriptHeader,
        [transaction("initial"), profileChunk],
      ]);
      expect(pipeline.getProfile("trace")?.platform).toBe("javascript");
      expect(pipeline.getEvent("first")?.platform).toBe("javascript");
    } finally {
      pipeline.dispose();
    }
  },
);
