import { describe, expect, test } from "vitest";
import { decodeEnvelope, type LocalFeedItem } from "./spotlight.js";
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
  test.each([undefined, "remote-parent"])(
    "promotes a late streamed segment title and reparents earlier children (parent: %s)",
    (parentId) => {
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
      expect(buildTraceGroups(earlyItems)[0]?.roots).toMatchObject([
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
      const [trace] = buildTraceGroups(items);
      expect(trace).toMatchObject({
        title: "GET /orders",
        startTimestamp: 1700000000,
        endTimestamp: 1700000001,
        durationMs: 1000,
        itemCount: 3,
        roots: [{ id: "root", children: [{ id: "query", durationMs: 125 }] }],
      });
      expect(trace.spans).toHaveLength(2);
      expect(trace.roots).toHaveLength(1);
      expect(trace.roots[0]?.children).toHaveLength(1);
    },
  );

  test.each([true, false])(
    "combines legacy transactions and streamed spans without duplicate spans (transaction first: %s)",
    (transactionFirst) => {
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
      const traces = buildTraceGroups(
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
    expect(trace.spans).toHaveLength(70001);
    expect(trace.roots).toHaveLength(1);
    expect(trace.roots[0]?.children).toHaveLength(70000);
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

test("child spans retain their own raw payload independently of the transaction", () => {
  const payload = {
    span_id: "query",
    parent_span_id: "root",
    op: "db.query",
    data: { "db.system": "postgresql" },
    start_timestamp: 1.1,
    timestamp: 1.2,
  };
  const [trace] = buildTraceGroups(
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
  expect(trace.spans.find((span) => span.id === "query")?.payload).toEqual(
    payload,
  );
});

test.each([true, false])(
  "merges partial duplicate roots without losing details (transaction first: %s)",
  (transactionFirst) => {
    const decode = (type: string, payload: unknown) =>
      decodeEnvelope(JSON.stringify([{}, [[{ type }, payload]]]), type);
    const transaction = decode("transaction", {
      transaction: "GET /orders",
      start_timestamp: 1,
      timestamp: 2,
      contexts: {
        trace: {
          trace_id: "t",
          span_id: "root",
          op: "http.server",
          data: { "http.response_content_length": 123 },
        },
      },
      request: { method: "GET" },
    });
    const segment = decode("span", {
      version: 2,
      items: [
        {
          trace_id: "t",
          span_id: "root",
          is_segment: true,
          start_timestamp: 1.2,
          end_timestamp: 1.8,
          attributes: { "sentry.origin": { value: "auto.http" } },
        },
      ],
    });
    const [trace] = buildTraceGroups(
      transactionFirst
        ? [...transaction, ...segment]
        : [...segment, ...transaction],
    );
    expect(trace?.title).toBe("GET /orders");
    expect(trace?.spans).toHaveLength(1);
    expect(trace?.spans[0]).toMatchObject({
      description: "GET /orders",
      operation: "http.server",
      startTimestamp: 1,
      endTimestamp: 2,
      durationMs: 1000,
      metadata: { method: "GET", origin: "auto.http" },
      payload: {
        contexts: { trace: { data: { "http.response_content_length": 123 } } },
        attributes: { "sentry.origin": { value: "auto.http" } },
      },
    });
    expect(transaction[0]?.payload).not.toHaveProperty("attributes");
    expect(segment[0]?.payload).not.toHaveProperty("contexts");
  },
);

test("cycles keep every captured span reachable without changing declared parent IDs", () => {
  const items = decodeEnvelope(
    JSON.stringify([
      {},
      [
        [
          { type: "span" },
          {
            version: 2,
            items: [
              { span_id: "a", parent_span_id: "b" },
              { span_id: "b", parent_span_id: "a" },
              { span_id: "child", parent_span_id: "b" },
              { span_id: "self", parent_span_id: "self" },
            ].map((span) => ({
              ...span,
              trace_id: "cycle",
              start_timestamp: 1,
              end_timestamp: 2,
            })),
          },
        ],
      ],
    ]),
    "cycle",
  );
  const [trace] = buildTraceGroups(items);
  const pending = [...trace!.roots];
  const seen = new Set<string>();
  while (pending.length) {
    const span = pending.pop()!;
    expect(seen.has(span.id)).toBe(false);
    seen.add(span.id);
    pending.push(...span.children);
  }
  expect([...seen].sort()).toEqual(["a", "b", "child", "self"]);
  expect(trace?.spans.find((span) => span.id === "a")?.parentId).toBe("b");
  expect(trace?.spans.find((span) => span.id === "b")?.parentId).toBe("a");
});

test.each([true, false])(
  "blank segment names cannot replace a captured trace title (named first: %s)",
  (namedFirst) => {
    const named = {
      span_id: "named",
      name: "GET /orders",
      start_timestamp: 1,
      end_timestamp: 2,
    };
    const blank = {
      span_id: "blank",
      name: "   ",
      start_timestamp: 2,
      end_timestamp: 3,
    };
    const items = decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "span" },
            {
              version: 2,
              items: (namedFirst ? [named, blank] : [blank, named]).map(
                (span) => ({
                  ...span,
                  trace_id: "titles",
                  is_segment: true,
                  attributes: { "sentry.op": { value: "http.server" } },
                }),
              ),
            },
          ],
        ],
      ]),
      "titles",
    );
    expect(buildTraceGroups(items)[0]?.title).toBe("GET /orders");
  },
);

test.each([
  ["GET /orders/42", "GET /orders/42"],
  ["   ", "/orders/42"],
  [undefined, "/orders/42"],
])(
  "HTTP segment trace titles prefer useful captured names over URLs: %j",
  (name, title) => {
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
                  span_id: "http-root",
                  trace_id: "http-title",
                  name,
                  is_segment: true,
                  start_timestamp: 1,
                  end_timestamp: 2,
                  attributes: {
                    "sentry.op": { value: "http.server" },
                    "url.full": { value: "https://example.test/orders/42" },
                  },
                },
              ],
            },
          ],
        ],
      ]),
      "http-title",
    );
    expect(buildTraceGroups(items)[0]).toMatchObject({
      title,
      spans: [{ description: title }],
    });
  },
);

test.each([true, false])(
  "URL-only partial updates preserve captured HTTP names (named first: %s)",
  (namedFirst) => {
    const span = {
      span_id: "http-root",
      trace_id: "partial-http-title",
      is_segment: true,
      start_timestamp: 1,
      attributes: {
        "sentry.op": { value: "http.server" },
        "url.full": { value: "https://example.test/orders/42" },
      },
    };
    const capture = (payload: unknown, id: string) =>
      decodeEnvelope(
        JSON.stringify([
          {},
          [[{ type: "span" }, { version: 2, items: [payload] }]],
        ]),
        id,
      );
    const named = { ...span, name: "GET /orders/42", end_timestamp: 2 };
    const partial = { ...span, end_timestamp: 3 };
    const items = (namedFirst ? [named, partial] : [partial, named]).flatMap(
      (payload, index) => capture(payload, `capture-${index}`),
    );
    expect(buildTraceGroups(items)[0]).toMatchObject({
      title: "GET /orders/42",
      spans: [
        {
          description: "GET /orders/42",
          metadata: { title: "GET /orders/42" },
          endTimestamp: 3,
        },
      ],
    });
    expect(
      buildTraceGroups([
        ...items,
        ...capture(
          { ...span, name: "POST /orders/42", end_timestamp: 4 },
          "renamed",
        ),
      ])[0],
    ).toMatchObject({
      title: "POST /orders/42",
      spans: [{ description: "POST /orders/42", endTimestamp: 4 }],
    });
  },
);

test.each([true, false])(
  "duplicate spans use the latest completion for captured values (draft first: %s)",
  (draftFirst) => {
    const draft = {
      trace_id: "updates",
      span_id: "chat",
      description: "Chat",
      op: "gen_ai.chat",
      start_timestamp: 1,
      timestamp: 2,
      status: "ok",
      data: { response: "Draft", model: "captured-model" },
    };
    const final = {
      ...draft,
      timestamp: 3,
      status: "internal_error",
      data: { response: "Final" },
    };
    const partial = {
      trace_id: "updates",
      span_id: "chat",
      start_timestamp: 1,
      timestamp: 4,
      status: undefined,
      data: { response: undefined, partial: true },
    };
    const decode = (payload: unknown, id: string) =>
      decodeEnvelope(JSON.stringify([{}, [[{ type: "span" }, payload]]]), id);
    const initial = draftFirst ? [draft, final] : [final, draft];
    const entries = initial.flatMap((payload, index) =>
      decode(payload, String(index)),
    );
    const [completed] = buildTraceGroups(entries);
    expect(completed?.spans[0]).toMatchObject({
      description: "Chat",
      endTimestamp: 3,
      metadata: { spanStatus: "internal_error" },
      payload: {
        timestamp: 3,
        status: "internal_error",
        data: { response: "Final", model: "captured-model" },
      },
    });
    const [updated] = buildTraceGroups([
      ...entries,
      ...decode(partial, "partial"),
    ]);
    expect(updated?.spans[0]).toMatchObject({
      description: "Chat",
      operation: "gen_ai.chat",
      endTimestamp: 4,
      metadata: { spanStatus: "internal_error" },
      payload: {
        timestamp: 4,
        status: "internal_error",
        data: { response: "Final", model: "captured-model", partial: true },
      },
    });
  },
);

test.each([
  [[0, 1, 2]],
  [[0, 2, 1]],
  [[1, 0, 2]],
  [[1, 2, 0]],
  [[2, 0, 1]],
  [[2, 1, 0]],
])("partial span fields follow captured completion order: %j", (order) => {
  const captures = [
    { name: "GET /first", end_timestamp: 2, data: { result: "old" } },
    { end_timestamp: 4, data: { pending: true } },
    { name: "POST /renamed", end_timestamp: 3, data: { result: "new" } },
  ];
  const items = order.flatMap((index) =>
    decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "span" },
            {
              ...captures[index]!,
              trace_id: "field-order",
              span_id: "root",
              is_segment: true,
              start_timestamp: 1,
              attributes: {
                "sentry.op": { value: "http.server" },
                "url.full": { value: "https://example.test/renamed" },
              },
            },
          ],
        ],
      ]),
      `capture-${index}`,
    ),
  );
  expect(buildTraceGroups(items)[0]).toMatchObject({
    title: "POST /renamed",
    spans: [
      {
        description: "POST /renamed",
        endTimestamp: 4,
        payload: { data: { result: "new", pending: true } },
      },
    ],
  });
});

test.each([
  { embedded: false, streamedFirst: false },
  { embedded: false, streamedFirst: true },
  { embedded: true, streamedFirst: false },
  { embedded: true, streamedFirst: true },
])(
  "captured names honor completion across envelope types: $embedded/$streamedFirst",
  ({ embedded, streamedFirst }) => {
    const transaction = decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "transaction" },
            {
              transaction: embedded ? "Parent" : "Before",
              start_timestamp: 1,
              timestamp: 2,
              contexts: {
                trace: {
                  trace_id: "mixed-updates",
                  span_id: embedded ? "parent" : "shared",
                },
              },
              ...(embedded
                ? {
                    spans: [
                      {
                        span_id: "shared",
                        parent_span_id: "parent",
                        description: "Before",
                        start_timestamp: 1,
                        timestamp: 2,
                      },
                    ],
                  }
                : {}),
            },
          ],
        ],
      ]),
      "transaction",
    );
    const streamed = decodeEnvelope(
      JSON.stringify([
        {},
        [
          [
            { type: "span" },
            {
              trace_id: "mixed-updates",
              span_id: "shared",
              name: "After",
              ...(embedded ? { parent_span_id: "parent" } : {}),
              start_timestamp: 1,
              end_timestamp: 3,
            },
          ],
        ],
      ]),
      "streamed",
    );
    const trace = buildTraceGroups(
      streamedFirst
        ? [...streamed, ...transaction]
        : [...transaction, ...streamed],
    )[0]!;
    expect(trace.spans.find((span) => span.id === "shared")).toMatchObject({
      description: "After",
      metadata: { title: "After" },
      endTimestamp: 3,
    });
    expect(trace.title).toBe(embedded ? "Parent" : "After");
  },
);

test.each([false, true])(
  "equal-priority trace titles update only for the chosen root (same root: %s)",
  (sameRoot) => {
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
                  span_id: "root",
                  name: "GET /first",
                  start_timestamp: 1,
                  end_timestamp: 2,
                },
                {
                  span_id: sameRoot ? "root" : "other-root",
                  name: "GET /later",
                  start_timestamp: 1,
                  end_timestamp: 3,
                },
              ].map((span) => ({
                ...span,
                trace_id: "stable-title",
                is_segment: true,
                attributes: { "sentry.op": { value: "http.server" } },
              })),
            },
          ],
        ],
      ]),
      "titles",
    );
    expect(buildTraceGroups(items)[0]?.title).toBe(
      sameRoot ? "GET /later" : "GET /first",
    );
  },
);

test.each([
  [0, 1, 2],
  [0, 2, 1],
  [2, 0, 1],
  [1, 0, 2],
])(
  "trace titles follow final parent links after reordered segment updates: %j",
  (...order) => {
    const captures = [
      {
        span_id: "child",
        name: "Child operation",
        start_timestamp: 1,
        end_timestamp: 2,
        is_segment: true,
      },
      {
        span_id: "child",
        parent_span_id: "parent",
        start_timestamp: 1,
        end_timestamp: 3,
      },
      {
        span_id: "parent",
        name: "Parent operation",
        start_timestamp: 1,
        end_timestamp: 4,
        is_segment: true,
      },
    ];
    const items = order.flatMap((index) =>
      decodeEnvelope(
        JSON.stringify([
          {},
          [
            [
              { type: "span" },
              {
                version: 2,
                items: [
                  {
                    ...captures[index]!,
                    trace_id: "late-parent",
                    attributes: { "sentry.op": { value: "http.server" } },
                  },
                ],
              },
            ],
          ],
        ]),
        `capture-${index}`,
      ),
    );
    const trace = buildTraceGroups(items)[0]!;
    expect(trace.title).toBe("Parent operation");
    expect(trace.roots).toMatchObject([
      { id: "parent", children: [{ id: "child" }] },
    ]);
  },
);
