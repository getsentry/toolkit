import { describe, expect, test } from "vitest";
import type { LocalFeedItem } from "./spotlight.js";
import { buildTraceGroups, traceIdForItem } from "./trace-model.js";

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
  test("reads trace timing in linear work for a long single trace", () => {
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
    const [trace] = buildTraceGroups(entries);
    expect(trace).toMatchObject({
      itemCount: 1000,
      logCount: 1000,
      startTimestamp: 0,
      endTimestamp: 999,
      durationMs: 999000,
    });
    expect(timestampReads).toBeLessThanOrEqual(entries.length * 2);
  });

  test("handles timing for a valid transaction with many child spans without argument overflow", () => {
    const spans = Array.from({ length: 70000 }, (_, index) => ({
      span_id: String(index),
      parent_span_id: "root",
      start_timestamp: index,
      timestamp: index + 1,
    }));
    const [trace] = buildTraceGroups([
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

  test("keeps a standalone transaction discoverable when it has no trace context", () => {
    const traces = buildTraceGroups([
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

  test("builds a timestamped span tree and correlates trace errors and logs", () => {
    const traces = buildTraceGroups([
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

  test("keeps a span visible when its declared parent is absent", () => {
    const traces = buildTraceGroups([
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

  test("nests a standalone span using its top-level parent span id", () => {
    const traces = buildTraceGroups([
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
