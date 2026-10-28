import { describe, expect, it } from "vitest";
import type { SentryProfileWithTraceMeta, Span, Trace } from "../types.ts";
import { getSpansFromProfile, graftProfileSpans } from "./profiles.ts";

function trace(): Trace {
  return {
    trace_id: "trace",
    start_timestamp: 0,
    timestamp: 10,
    transactions: [],
    errors: 0,
    rootTransaction: null,
    rootTransactionName: "test",
    spans: new Map(),
    spanTree: [],
    profileGrafted: false,
  };
}

function profile(
  overrides: Partial<SentryProfileWithTraceMeta> = {},
): SentryProfileWithTraceMeta {
  return {
    timestamp: 0,
    active_thread_id: "main",
    frames: [{ module: "app", function: "main" }],
    stacks: [[0]],
    samples: [{ thread_id: "main", stack_id: 0, start_timestamp: 0 }],
    ...overrides,
  };
}

describe("profile span frames", () => {
  it.each([undefined, "ruby", "javascript"])(
    "retains the first frame without a matching SDK frame on %s",
    (platform) => {
      const spans = getSpansFromProfile(
        trace(),
        profile({ platform }),
        undefined,
        0,
        10,
        new Set(),
      );
      expect(spans).toMatchObject([
        { description: "app", op: "main", start_timestamp: 0, timestamp: 10 },
      ]);
    },
  );

  it("still removes SDK frames and all their ancestors", () => {
    const spans = getSpansFromProfile(
      trace(),
      profile({
        platform: "javascript",
        frames: [
          { module: "runtime", function: "run" },
          { module: "@sentry/core", function: "instrument" },
          { module: "app", function: "main" },
        ],
        stacks: [[0, 1, 2]],
      }),
      undefined,
      0,
      10,
      new Set(),
    );
    expect(spans).toMatchObject([{ description: "app", op: "main" }]);
  });

  it.each([
    {
      module: "@angular/core",
      function: "render@component",
      lineno: 12,
      colno: 3,
    },
    {
      filename: "user@app.ts",
      function: "render@component",
      lineno: 12,
      colno: 3,
    },
  ])("preserves @ characters in module and function names", (frame) => {
    const spans = getSpansFromProfile(
      trace(),
      profile({ platform: "javascript", frames: [frame] }),
      undefined,
      0,
      10,
      new Set(),
    );
    expect(spans).toMatchObject([
      {
        description: frame.module ?? frame.filename,
        op: "render@component:12:3",
      },
    ]);
  });
});

describe("profile graft thread selection", () => {
  it("keeps distinct threads with identical names and frames separate", () => {
    const spans = getSpansFromProfile(
      trace(),
      profile({
        thread_metadata: {
          main: { name: "Thread" },
          worker: { name: "Thread" },
        },
        samples: [
          { thread_id: "main", stack_id: 0, start_timestamp: 0 },
          { thread_id: "worker", stack_id: 0, start_timestamp: 5 },
          { thread_id: "main", stack_id: 0, start_timestamp: 10 },
          { thread_id: "worker", stack_id: 0, start_timestamp: 15 },
        ],
      }),
      undefined,
      0,
      20,
      new Set(["worker"]),
    );
    expect(spans).toMatchObject([
      {
        data: { thread_id: "main" },
        children: [{ op: "main", start_timestamp: 0, timestamp: 10 }],
      },
      {
        data: { thread_id: "worker" },
        children: [{ op: "main", start_timestamp: 5, timestamp: 15 }],
      },
      {
        data: { thread_id: "main" },
        children: [{ op: "main", start_timestamp: 10, timestamp: 20 }],
      },
      {
        data: { thread_id: "worker" },
        children: [{ op: "main", start_timestamp: 15, timestamp: 20 }],
      },
    ]);
  });

  it("still consolidates consecutive samples and frames within one thread", () => {
    const spans = getSpansFromProfile(
      trace(),
      profile({
        samples: [
          { thread_id: "main", stack_id: 0, start_timestamp: 0 },
          { thread_id: "main", stack_id: 0, start_timestamp: 5 },
          { thread_id: "main", stack_id: 0, start_timestamp: 10 },
        ],
      }),
      undefined,
      0,
      20,
      new Set(),
    );
    expect(spans).toMatchObject([
      { op: "main", start_timestamp: 0, timestamp: 20 },
    ]);
  });

  it("keeps simultaneous and interleaved thread intervals through their own next samples", () => {
    const target = trace();
    const spans = getSpansFromProfile(
      target,
      profile({
        frames: [
          { module: "app", function: "main" },
          { module: "app", function: "worker" },
        ],
        stacks: [[0], [1]],
        samples: [
          { thread_id: "main", stack_id: 0, start_timestamp: 0 },
          { thread_id: "worker", stack_id: 1, start_timestamp: 0 },
          { thread_id: "main", stack_id: 0, start_timestamp: 10 },
          { thread_id: "worker", stack_id: 1, start_timestamp: 15 },
        ],
      }),
      undefined,
      0,
      20,
      new Set(["worker"]),
    );
    expect(spans).toMatchObject([
      {
        description: "Thread main",
        children: [{ op: "main", start_timestamp: 0, timestamp: 10 }],
      },
      {
        description: "Thread worker",
        children: [{ op: "worker", start_timestamp: 0, timestamp: 15 }],
      },
      {
        description: "Thread main",
        children: [{ op: "main", start_timestamp: 10, timestamp: 20 }],
      },
      {
        description: "Thread worker",
        children: [{ op: "worker", start_timestamp: 15, timestamp: 20 }],
      },
    ]);
    // The trailing worker sample is flushed into both the tree and span lookup.
    expect(target.spans.get(spans[3].span_id)).toBe(spans[3]);
  });

  it("keeps gap bounds when a same-thread next sample falls beyond the gap", () => {
    const spans = getSpansFromProfile(
      trace(),
      profile({
        samples: [
          { thread_id: "main", stack_id: 0, start_timestamp: 0 },
          { thread_id: "main", stack_id: 0, start_timestamp: 4 },
          { thread_id: "main", stack_id: 0, start_timestamp: 12 },
        ],
      }),
      undefined,
      2,
      8,
      new Set(),
    );
    expect(spans).toEqual([]);
  });

  it.each(["previous", "next", "parent"])(
    "uses the Sentry thread.id from the %s span",
    (source) => {
      const target = trace();
      const neighbor: Span = {
        span_id: "neighbor",
        start_timestamp: source === "next" ? 5 : 0,
        timestamp: source === "next" ? 10 : 5,
        data: { "thread.id": 7 },
      };
      if (source === "parent") target.data = { "thread.id": 7 };
      else target.spanTree = [neighbor];
      const start = source === "previous" ? 5 : 0;
      graftProfileSpans(
        target,
        profile({
          platform: "javascript",
          samples: [{ thread_id: "7", stack_id: 0, start_timestamp: start }],
        }),
      );
      expect(
        target.spanTree.filter((span) => span.tags?.source === "profile"),
      ).toMatchObject([{ description: "app", op: "main" }]);
      expect(target.profileGrafted).toBe(true);
    },
  );

  it("retains active-thread and legacy threadId fallbacks", () => {
    const target = trace();
    target.data = { threadId: "worker" };
    graftProfileSpans(
      target,
      profile({
        platform: "javascript",
        frames: [
          { module: "app", function: "main" },
          { module: "app", function: "worker" },
        ],
        stacks: [[0], [1]],
        samples: [
          { thread_id: "main", stack_id: 0, start_timestamp: 0 },
          { thread_id: "worker", stack_id: 1, start_timestamp: 5 },
        ],
      }),
    );
    expect(target.spanTree.map((span) => span.children?.[0]?.op)).toEqual([
      "main",
      "worker",
    ]);
  });
});
