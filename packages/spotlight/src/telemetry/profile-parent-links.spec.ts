import { expect, test } from "vitest";
import { createTelemetryStore, serializeTrace } from "../sdk/core.ts";

test.each([
  {
    name: "appended thread children",
    stacks: [["main"], ["other"], ["main"]],
    rootOps: ["main", "other", "main"],
  },
  {
    name: "children adopted from an initially empty thread",
    stacks: [[], ["main"], ["other"]],
    rootOps: ["main", "other"],
  },
  {
    name: "adopted and appended frame children across sibling continuations",
    stacks: [
      ["main"],
      ["main", "left"],
      ["main", "right"],
      ["other"],
      ["main", "last"],
    ],
    rootOps: ["main", "other", "main"],
  },
  {
    name: "consolidated children under retained thread wrappers",
    stacks: [["main"], ["other"], ["main"], ["worker"]],
    threads: ["main", "main", "main", "worker"],
    rootOps: ["Thread", "Thread"],
  },
  {
    name: "adopted children under retained thread wrappers",
    stacks: [[], ["main"], ["other"], ["worker"]],
    threads: ["main", "main", "main", "worker"],
    rootOps: ["Thread", "Thread"],
  },
])(
  "public profile serialization preserves parent links for $name",
  async ({ stacks, threads, rootOps }) => {
    const store = createTelemetryStore();
    try {
      const functions = [...new Set(stacks.flat())];
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
                  transaction: "profile parent links",
                  start_timestamp: 1,
                  timestamp: 2,
                  contexts: {
                    trace: {
                      trace_id: "trace",
                      span_id: "root",
                      data: { "thread.id": "worker" },
                    },
                  },
                },
              ],
              [
                { type: "profile" },
                {
                  event_id: "profile",
                  version: "1",
                  timestamp: 1,
                  platform: "javascript",
                  transaction: { trace_id: "trace", active_thread_id: "main" },
                  profile: {
                    frames: functions.map((fn) => ({
                      module: "app",
                      function: fn,
                    })),
                    // Sentry profiles encode stacks from leaf to root.
                    stacks: stacks.map((stack) =>
                      stack.map((fn) => functions.indexOf(fn)).reverse(),
                    ),
                    samples: stacks.map((_, index) => ({
                      thread_id: threads?.[index] ?? "main",
                      stack_id: index,
                      elapsed_since_start_ns: String((index + 1) * 100_000_000),
                    })),
                  },
                },
              ],
            ],
          ])
        ).status,
      ).toBe("processed");

      const trace = store.getTrace("trace")!;
      // Exercise the actual JSON contract, where children are flat IDs.
      const serialized = JSON.parse(
        JSON.stringify(serializeTrace(trace)),
      ) as ReturnType<typeof serializeTrace>;
      const spans = new Map(serialized.spans);
      const root = spans.get("root")!;
      expect(root.childSpanIds.map((id) => spans.get(id)?.op)).toEqual(rootOps);
      expect(serialized.spanTree).toEqual(["root"]);
      for (const [id, span] of spans) {
        expect(
          trace.spans.has(id),
          `serialized span ${id} is in the public lookup`,
        ).toBe(true);
        for (const childId of span.childSpanIds) {
          expect(spans.get(childId)?.parent_span_id, `child of ${id}`).toBe(id);
        }
        if (id !== "root") {
          const parent = spans.get(span.parent_span_id as string);
          expect(parent, `parent of ${id} resolves`).toBeDefined();
          expect(parent?.childSpanIds, `parent contains ${id}`).toContain(id);
        }
      }
      if (stacks.length === 5) {
        const firstMain = spans.get(root.childSpanIds[0])!;
        expect(firstMain.childSpanIds.map((id) => spans.get(id)?.op)).toEqual([
          "left",
          "right",
        ]);
        const lastMain = spans.get(root.childSpanIds[2])!;
        expect(lastMain.childSpanIds.map((id) => spans.get(id)?.op)).toEqual([
          "last",
        ]);
      }
    } finally {
      store.dispose();
    }
  },
);
