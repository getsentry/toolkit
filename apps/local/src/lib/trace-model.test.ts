import { describe, expect, test } from "vitest";
import { decodeEnvelope, type LocalFeedItem } from "./spotlight.js";
import { traceIdForItem } from "./trace-model.js";
import { buildTraceGroups } from "../test-fixtures/trace-groups.ts";

function item(overrides: Partial<LocalFeedItem>): LocalFeedItem {
  return {
    id: "item-1",
    type: "transaction",
    text: "{}",
    payload: {},
    metadata: { title: "GET /orders/42" },
    ...overrides,
  };
}

describe("buildTraceGroups", () => {
  test.each([undefined, "remote-parent"])(
    "promotes a late streamed segment title and reparents earlier children (parent: %s)",
    async (parentId) => {
      const child = {
        trace_id: "trace-stream",
        span_id: "query",
        parent_span_id: "root",
        name: "SELECT 1",
        start_timestamp: 1700000000.125,
        end_timestamp: 1700000000.25,
        attributes: { "sentry.op": { type: "string", value: "db" } },
      };
      const decode = (items: unknown[], id: string) =>
        decodeEnvelope(
          JSON.stringify([{}, [[{ type: "span" }, { version: 2, items }]]]),
          id,
        );
      const earlyItems = decode([child], "child");
      expect((await buildTraceGroups(earlyItems))[0]?.roots).toMatchObject([
        { id: "query" },
      ]);
      const items = [
        ...earlyItems,
        ...decode(
          [
            {
              trace_id: "trace-stream",
              span_id: "root",
              parent_span_id: parentId,
              name: "GET /orders",
              start_timestamp: 1700000000,
              end_timestamp: 1700000001,
              is_segment: true,
              attributes: {
                "sentry.op": { type: "string", value: "http.server" },
              },
            },
          ],
          "segment",
        ),
        ...decode([child], "redelivery"),
      ];
      const [trace] = await buildTraceGroups(items);
      expect(trace).toMatchObject({
        title: "GET /orders",
        startTimestamp: 1700000000,
        endTimestamp: 1700000001,
        durationMs: 1000,
        itemCount: 3,
        roots: [{ id: "root", children: [{ id: "query", durationMs: 125 }] }],
      });
      expect(trace?.spans).toHaveLength(2);
      expect(trace?.roots).toHaveLength(1);
      expect(trace?.roots[0]?.children).toHaveLength(1);
    },
  );

  test.each([true, false])(
    "combines legacy transactions and streamed spans without duplicate spans (transaction first: %s)",
    async (transactionFirst) => {
      const transaction = decodeEnvelope(
        JSON.stringify([
          {},
          [
            [
              { type: "transaction" },
              {
                transaction: "GET /orders",
                start_timestamp: 1700000000,
                timestamp: 1700000001,
                contexts: {
                  trace: {
                    trace_id: "trace-mixed",
                    span_id: "root",
                    op: "http.server",
                  },
                },
                spans: [
                  {
                    span_id: "query",
                    parent_span_id: "root",
                    description: "SELECT 1",
                    op: "db",
                    start_timestamp: 1700000000.125,
                    timestamp: 1700000000.25,
                  },
                ],
              },
            ],
          ],
        ]),
        "legacy",
      );
      const streamed = decodeEnvelope(
        JSON.stringify([
          {},
          [
            [
              { type: "span" },
              {
                version: 2,
                items: [
                  {
                    trace_id: "trace-mixed",
                    span_id: "query",
                    parent_span_id: "root",
                    name: "SELECT 1",
                    start_timestamp: 1700000000.125,
                    end_timestamp: 1700000000.25,
                    attributes: {
                      "sentry.op": { type: "string", value: "db" },
                    },
                  },
                  {
                    trace_id: "other-trace",
                    span_id: "query",
                    name: "other query",
                    start_timestamp: 1700000002,
                    end_timestamp: 1700000003,
                  },
                ],
              },
            ],
          ],
        ]),
        "streamed",
      );
      const traces = await buildTraceGroups(
        transactionFirst
          ? [...transaction, ...streamed]
          : [...streamed, ...transaction],
      );
      expect(traces).toHaveLength(2);
      const trace = traces.find((value) => value.id === "trace-mixed");
      expect(trace).toMatchObject({
        title: "GET /orders",
        durationMs: 1000,
        roots: [{ id: "root", children: [{ id: "query", durationMs: 125 }] }],
      });
      expect(trace?.spans).toHaveLength(2);
      expect(trace?.roots[0]?.children).toHaveLength(1);
    },
  );

  test("reads trace timing in linear work for a long single trace", async () => {
    let timestampReads = 0;
    const entries: LocalFeedItem[] = Array.from(
      { length: 1000 },
      (_, index) => ({
        id: String(index),
        type: "log",
        text: "{}",
        payload: {},
        metadata: { title: "log", traceId: "busy-trace" },
        get timestamp() {
          timestampReads += 1;
          return index;
        },
      }),
    );
    const [trace] = await buildTraceGroups(entries);
    expect(trace).toMatchObject({
      itemCount: 1000,
      logCount: 1000,
      startTimestamp: 0,
      endTimestamp: 999,
      durationMs: 999000,
    });
    expect(timestampReads).toBeLessThanOrEqual(entries.length * 2);
  });

  test("handles timing for a valid transaction with many child spans without argument overflow", async () => {
    const spans = Array.from({ length: 70000 }, (_, index) => ({
      span_id: String(index),
      parent_span_id: "root",
      start_timestamp: index,
      timestamp: index + 1,
    }));
    const [trace] = await buildTraceGroups([
      item({
        metadata: { title: "large transaction", traceId: "large-trace" },
        payload: {
          contexts: { trace: { span_id: "root" } },
          start_timestamp: 0,
          timestamp: 70000,
          spans,
        },
      }),
    ]);
    expect(trace).toMatchObject({
      startTimestamp: 0,
      endTimestamp: 70000,
      durationMs: 70000000,
      itemCount: 1,
    });
    expect(trace?.spans).toHaveLength(70001);
    expect(trace?.roots).toHaveLength(1);
    expect(trace?.roots[0]?.children).toHaveLength(70000);
  });

  test("uses a transaction ID as the trace fallback used by routing", () => {
    expect(
      traceIdForItem(
        item({
          id: "transaction-without-trace",
          metadata: { title: "GET /standalone" },
        }),
      ),
    ).toBe("transaction-without-trace");
  });

  test("keeps a standalone transaction discoverable when it has no trace context", async () => {
    const traces = await buildTraceGroups([
      {
        id: "transaction-without-trace",
        type: "transaction",
        timestamp: 1_700_000_000_000,
        text: "{}",
        payload: {},
        metadata: { title: "GET /standalone" },
      },
    ]);

    expect(traces).toHaveLength(1);
    expect(traces[0]?.id).toBe("transaction-without-trace");
    expect(traces[0]?.title).toBe("GET /standalone");
  });

  test("builds a timestamped span tree and correlates trace errors and logs", async () => {
    const traces = await buildTraceGroups([
      item({
        id: "transaction",
        timestamp: 1_700_000_000.012,
        metadata: {
          title: "GET /orders/42",
          traceId: "trace-42",
          spanId: "root-span",
          operation: "http.server",
          durationMs: 12,
        },
        payload: {
          transaction: "GET /orders/42",
          start_timestamp: 1_700_000_000,
          timestamp: 1_700_000_000.012,
          contexts: {
            trace: {
              trace_id: "trace-42",
              span_id: "root-span",
              op: "http.server",
            },
          },
          spans: [
            {
              span_id: "db-span",
              parent_span_id: "root-span",
              op: "db.query",
              description: "SELECT * FROM orders",
              start_timestamp: 1_700_000_000.002,
              timestamp: 1_700_000_000.005,
            },
            {
              span_id: "client-span",
              parent_span_id: "root-span",
              op: "http.client",
              description: "GET https://inventory.test/items/42",
              start_timestamp: 1_700_000_000.006,
              timestamp: 1_700_000_000.01,
            },
          ],
        },
      }),
      item({
        id: "log",
        type: "log",
        metadata: {
          title: "Inventory lookup finished",
          traceId: "trace-42",
          level: "info",
        },
      }),
      item({
        id: "error",
        type: "event",
        metadata: {
          title: "Order failed",
          traceId: "trace-42",
          level: "error",
        },
      }),
    ]);

    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      id: "trace-42",
      title: "GET /orders/42",
      itemCount: 3,
      logCount: 1,
      errorCount: 1,
      startTimestamp: 1_700_000_000,
      endTimestamp: 1_700_000_000.012,
      durationMs: 12,
    });
    expect(traces[0]?.roots).toMatchObject([
      {
        id: "root-span",
        operation: "http.server",
        children: [
          { id: "db-span", operation: "db.query", durationMs: 3 },
          { id: "client-span", operation: "http.client", durationMs: 4 },
        ],
      },
    ]);
  });

  test("keeps a span visible when its declared parent is absent", async () => {
    const traces = await buildTraceGroups([
      item({
        metadata: {
          title: "orphaned work",
          traceId: "trace-orphan",
          spanId: "orphan-span",
        },
        payload: {
          start_timestamp: 1_700_000_000,
          timestamp: 1_700_000_000.001,
          contexts: {
            trace: {
              trace_id: "trace-orphan",
              span_id: "orphan-span",
              parent_span_id: "missing-parent",
              op: "db.query",
            },
          },
        },
      }),
    ]);

    expect(traces[0]?.roots).toMatchObject([
      { id: "orphan-span", parentId: "missing-parent", operation: "db.query" },
    ]);
  });

  test.each([true, false])(
    "orders promoted missing-parent spans with their visible siblings (real root: %s)",
    async (hasRoot) => {
      const [trace] = await buildTraceGroups(
        decodeEnvelope(
          JSON.stringify([
            {},
            [
              [
                { type: "span" },
                {
                  version: 2,
                  items: [
                    ...(hasRoot
                      ? [{ span_id: "root", start_timestamp: 0 }]
                      : []),
                    {
                      span_id: "a",
                      parent_span_id: "missing-parent",
                      start_timestamp: 1,
                    },
                    {
                      span_id: "b",
                      parent_span_id: hasRoot ? "root" : "other-missing-parent",
                      start_timestamp: 2,
                    },
                    {
                      span_id: "c",
                      parent_span_id: "missing-parent",
                      start_timestamp: 3,
                    },
                  ].map((span) => ({
                    ...span,
                    trace_id: "trace-promoted-order",
                    end_timestamp: 4,
                    attributes: {
                      "sentry.op": { type: "string", value: "task" },
                    },
                  })),
                },
              ],
            ],
          ]),
          "promoted-order",
        ),
      );

      if (hasRoot) expect(trace?.roots).toHaveLength(1);
      const siblings = hasRoot ? trace?.roots[0]?.children : trace?.roots;
      expect(siblings?.map((span) => span.id)).toEqual(["a", "b", "c"]);
      expect(siblings?.map((span) => span.parentId)).toEqual([
        "missing-parent",
        hasRoot ? "root" : "other-missing-parent",
        "missing-parent",
      ]);
    },
  );

  test("nests a standalone span using its top-level parent span id", async () => {
    const traces = await buildTraceGroups([
      item({
        id: "root",
        metadata: {
          title: "POST /agent/run",
          traceId: "trace-agent",
          spanId: "root-span",
          operation: "http.server",
        },
        payload: {
          transaction: "POST /agent/run",
          start_timestamp: 1_700_000_000,
          timestamp: 1_700_000_000.01,
          contexts: {
            trace: {
              trace_id: "trace-agent",
              span_id: "root-span",
              op: "http.server",
            },
          },
        },
      }),
      item({
        id: "child",
        type: "span",
        metadata: {
          title: "agent.run",
          traceId: "trace-agent",
          spanId: "child-span",
          operation: "gen_ai.invoke_agent",
        },
        payload: {
          trace_id: "trace-agent",
          span_id: "child-span",
          parent_span_id: "root-span",
          start_timestamp: 1_700_000_000.002,
          end_timestamp: 1_700_000_000.006,
        },
      }),
    ]);

    expect(traces[0]?.roots).toMatchObject([
      {
        id: "root-span",
        children: [
          { id: "child-span", operation: "gen_ai.invoke_agent", durationMs: 4 },
        ],
      },
    ]);
  });
});

test("child spans retain their own raw payload independently of the transaction", async () => {
  const payload = {
    span_id: "query",
    parent_span_id: "root",
    op: "db.query",
    data: { "db.system": "postgresql" },
    start_timestamp: 1.1,
    timestamp: 1.2,
  };
  const [trace] = await buildTraceGroups(
    decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: "GET /orders",
              start_timestamp: 1,
              timestamp: 2,
              contexts: { trace: { trace_id: "trace", span_id: "root" } },
              spans: [payload],
            },
          ],
        ],
      ]),
      "payload",
    ),
  );
  expect(trace?.spans.find((span) => span.id === "query")?.payload).toEqual(
    payload,
  );
});
