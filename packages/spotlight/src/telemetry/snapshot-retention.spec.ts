import { expect, test } from "vitest";
import { createTelemetryStore, serializeSnapshot } from "../sdk/core.ts";

const transaction = (id: string, traceId = id, profilerId?: string) => [
  { type: "transaction" },
  {
    event_id: id,
    type: "transaction",
    transaction: id,
    start_timestamp: 1,
    timestamp: 2,
    contexts: {
      trace: { trace_id: traceId, span_id: id },
      ...(profilerId ? { profile: { profiler_id: profilerId } } : {}),
    },
  },
];
const log = (id: string, logId: string, traceId: string) => [
  { type: "log" },
  {
    event_id: id,
    type: "log",
    timestamp: 1,
    items: [{ id: logId, trace_id: traceId, timestamp: 1.5, body: id }],
  },
];
const chunk = [
  { type: "profile_chunk" },
  {
    event_id: "chunk",
    type: "profile_chunk",
    version: "2",
    timestamp: 1,
    profiler_id: "profiler",
    chunk_id: "chunk",
    platform: "javascript",
    profile: {
      frames: [{ module: "app", function: "work" }],
      stacks: [[0]],
      samples: [1.1, 1.2, 1.3].map((timestamp) => ({
        timestamp,
        stack_id: 0,
        thread_id: "main",
      })),
    },
  },
];
const profile = [
  { type: "profile" },
  {
    event_id: "profile",
    type: "profile",
    version: "1",
    timestamp: 1,
    platform: "javascript",
    transactions: [{ trace_id: "shared", active_thread_id: "main" }],
    profile: {
      frames: [{ module: "app", function: "work" }],
      stacks: [[0]],
      samples: [100000000, 200000000, 300000000].map(
        (elapsed_since_start_ns) => ({
          elapsed_since_start_ns,
          stack_id: 0,
          thread_id: "main",
        }),
      ),
    },
  },
];
function envelope(item: unknown, index: number, sdk = "sdk-a") {
  return [
    {
      sdk: { name: sdk, version: "1" },
      sent_at: new Date(index * 1000).toISOString(),
    },
    [item],
  ];
}

// Compare all public collections, including insertion order, against replay of
// only the retained journal. Deletion must promote later duplicate winners.
test.each([
  {
    name: "independent traces, SDK ordering and an opaque-only delivery",
    items: [
      transaction("old"),
      transaction("middle"),
      log("logs", "log", "log-trace"),
      [{ type: "future" }, { opaque: true }],
    ],
    sdks: ["sdk-a", "sdk-b", "sdk-a", "sdk-b"],
  },
  {
    name: "cross-envelope trace assembly",
    items: [
      transaction("old", "shared"),
      log("logs", "log", "shared"),
      transaction("new", "shared"),
    ],
  },
  {
    name: "duplicate event promotion with a different trace context",
    items: [
      transaction("duplicate", "old-trace"),
      transaction("duplicate", "new-trace"),
      transaction("other"),
    ],
  },
  {
    name: "duplicate log promotion with a different trace context",
    items: [
      log("old", "duplicate", "old-trace"),
      log("new", "duplicate", "new-trace"),
      transaction("other"),
    ],
  },
  {
    name: "continuous profiles shared by different traces",
    items: [
      transaction("old", "old-trace", "profiler"),
      chunk,
      transaction("new", "new-trace", "profiler"),
    ],
  },
  {
    name: "V1 profile and transaction retention",
    items: [
      transaction("old", "shared"),
      profile,
      transaction("new", "shared"),
    ],
  },
])("retention matches canonical replay for $name", async ({ items, sdks }) => {
  const bounded = createTelemetryStore({ retention: { maxEnvelopes: 2 } });
  const replayed = createTelemetryStore({ retention: { maxEnvelopes: 2 } });
  try {
    for (const [index, item] of items.entries()) {
      await bounded.ingestEnvelope(envelope(item, index, sdks?.[index]), {
        deliveryId: `delivery-${index}`,
      });
    }
    for (let index = items.length - 2; index < items.length; index++) {
      await replayed.ingestEnvelope(
        envelope(items[index], index, sdks?.[index]),
        { deliveryId: `delivery-${index}` },
      );
    }
    expect({
      ...serializeSnapshot(bounded.getSnapshot()),
      revision: 0,
    }).toEqual({ ...serializeSnapshot(replayed.getSnapshot()), revision: 0 });
    await bounded.setRetention({ maxEnvelopes: 1 });
    await replayed.setRetention({ maxEnvelopes: 1 });
    expect({
      ...serializeSnapshot(bounded.getSnapshot()),
      revision: 0,
    }).toEqual({ ...serializeSnapshot(replayed.getSnapshot()), revision: 0 });
  } finally {
    bounded.dispose();
    replayed.dispose();
  }
});

test.each([false, true])(
  "unread historical graphs survive profile grafting and eviction (duplicate V1 trace refs: %s)",
  async (duplicateTraceRefs) => {
    const store = createTelemetryStore({ retention: { maxEnvelopes: 3 } });
    try {
      await store.ingestEnvelope(envelope(transaction("root", "shared"), 1));
      await store.ingestEnvelope(
        envelope(log("old-log", "old-log", "shared"), 2),
      );
      const unread = store.getSnapshot();
      const profileItem = structuredClone(profile);
      if (duplicateTraceRefs) {
        const data = profileItem[1] as (typeof profile)[1] & {
          transactions: unknown[];
        };
        data.transactions.push(structuredClone(data.transactions[0]));
      }
      expect(
        (await store.ingestEnvelope(envelope(profileItem, 3))).status,
      ).toBe("processed");
      expect(store.getProfile("shared")).toBeDefined();
      expect(store.getTrace("shared")!.spans.size).toBeGreaterThan(1);
      await store.ingestEnvelope(
        envelope(log("new-log", "new-log", "shared"), 4),
      );
      expect(unread.events).toHaveLength(2);
      expect(unread.traces).toHaveLength(1);
      expect(unread.traces[0].spans.size).toBe(1);
      expect(unread.traces[0].transactions).toHaveLength(1);
      expect(unread.logs.map((item) => item.id)).toEqual(["old-log"]);
      expect(unread.sdks[0].lastSeen).toBe(2000);
      expect(unread.profiles.size).toBe(0);
      expect(store.getSnapshot().sdks[0].lastSeen).toBe(4000);
      expect(() =>
        (unread.traces[0].spans as Map<string, unknown>).clear(),
      ).toThrow("read-only");
    } finally {
      store.dispose();
    }
  },
);

test.each(["span", "profile chunk"])(
  "updating a 12,000-level trace with a later %s preserves the historical graph",
  async (update) => {
    const store = createTelemetryStore();
    const depth = 12000;
    try {
      await store.ingestEnvelope([
        {},
        [
          [
            { type: "transaction" },
            {
              event_id: "deep",
              type: "transaction",
              start_timestamp: 1,
              timestamp: 2,
              contexts: {
                trace: { trace_id: "deep", span_id: "root" },
                profile: { profiler_id: "profiler" },
              },
              spans: Array.from({ length: depth }, (_, index) => ({
                span_id: `real-${index}`,
                parent_span_id: index ? `real-${index - 1}` : "root",
                start_timestamp: 1,
                timestamp: 2,
              })),
            },
          ],
        ],
      ]);
      const previous = store.getSnapshot();
      const item =
        update === "span"
          ? [
              { type: "span" },
              {
                trace_id: "deep",
                span_id: "later",
                parent_span_id: `real-${depth - 1}`,
                start_timestamp: 1.1,
                timestamp: 1.2,
              },
            ]
          : chunk;
      expect((await store.ingestEnvelope(envelope(item, 2))).status).toBe(
        "processed",
      );
      const original = previous.traces[0];
      expect(original.spans.size).toBe(depth + 1);
      expect(
        original.spans.get(`real-${depth - 1}`)?.children ?? [],
      ).toHaveLength(0);
      expect(store.getTrace("deep")!.spans.size).toBeGreaterThan(
        original.spans.size,
      );
      expect(store.getTrace("deep")?.spans.get("root")?.transaction).toBe(
        store.getTrace("deep")?.transactions[0],
      );
    } finally {
      store.dispose();
    }
  },
);

test("affected replay preserves interleaved collection order and asynchronous item insertion order", async () => {
  const error = [
    { type: "event" },
    {
      event_id: "error",
      timestamp: 1,
      contexts: { trace: { trace_id: "shared" } },
      exception: { values: [{ type: "Error", value: "test" }] },
    },
  ];
  const envelopes = [
    envelope(transaction("root", "shared"), 0),
    envelope(transaction("unrelated-before"), 1),
    [
      envelope(error, 2)[0],
      [error, transaction("fast-item", "inside-envelope")],
    ],
    envelope(transaction("unrelated-after"), 3),
    envelope(transaction("late", "shared"), 4),
  ];
  const options = {
    retention: { maxEnvelopes: 4 },
    enrichStacktrace: async () => {
      await Promise.resolve();
    },
  };
  const store = createTelemetryStore(options);
  const canonical = createTelemetryStore(options);
  try {
    for (const [index, value] of envelopes.entries())
      await store.ingestEnvelope(value, { deliveryId: String(index) });
    for (const [index, value] of envelopes.entries())
      if (index)
        await canonical.ingestEnvelope(value, { deliveryId: String(index) });
    expect(store.getSnapshot().events.map((event) => event.event_id)).toEqual([
      "unrelated-before",
      "fast-item",
      "error",
      "unrelated-after",
      "late",
    ]);
    expect({ ...serializeSnapshot(store.getSnapshot()), revision: 0 }).toEqual({
      ...serializeSnapshot(canonical.getSnapshot()),
      revision: 0,
    });
  } finally {
    store.dispose();
    canonical.dispose();
  }
});

test("cancelled affected replay restores the journal, immutable snapshot and drain barrier", async () => {
  let promoted!: () => void;
  const ready = new Promise<void>((resolve) => {
    promoted = resolve;
  });
  let calls = 0;
  const store = createTelemetryStore({
    retention: { maxEnvelopes: 3 },
    enrichStacktrace: async (_event, { signal }) => {
      if (++calls === 1) return;
      promoted();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  });
  const error = (value: string) => [
    { type: "event" },
    {
      event_id: "duplicate",
      timestamp: 1,
      contexts: { trace: { trace_id: "shared" } },
      exception: { values: [{ type: "Error", value }] },
    },
  ];
  try {
    await store.ingestEnvelope(envelope(error("first"), 0), {
      deliveryId: "first",
    });
    await store.ingestEnvelope(envelope(error("promoted"), 1), {
      deliveryId: "promoted",
    });
    await store.ingestEnvelope(envelope(transaction("unrelated"), 2), {
      deliveryId: "unrelated",
    });
    const previous = store.getSnapshot();
    let changes = 0;
    store.subscribe(() => {
      changes++;
    });
    const controller = new AbortController();
    const operation = store.ingestEnvelope(envelope(transaction("new"), 3), {
      deliveryId: "new",
      signal: controller.signal,
    });
    const drained = store.drain();
    await ready;
    expect(store.getSnapshot()).toBe(previous);
    controller.abort();
    expect(await operation).toMatchObject({
      status: "ignored",
      reason: "aborted",
    });
    await drained;
    expect(store.getStats().pending).toBe(0);
    expect(store.getStats().retainedEnvelopes).toBe(3);
    expect(store.getSnapshot()).toBe(previous);
    expect(previous.events.map((event) => event.event_id)).toEqual([
      "duplicate",
      "unrelated",
    ]);
    expect(changes).toBe(0);
    // The rebuilt provenance must also support the next successful eviction.
    await store.setRetention({ maxEnvelopes: 1 });
    expect(store.getSnapshot().events.map((event) => event.event_id)).toEqual([
      "unrelated",
    ]);
  } finally {
    store.dispose();
  }
});

test("reset during affected replay cannot replace the new generation's engine", async () => {
  let promoted!: () => void;
  const ready = new Promise<void>((resolve) => {
    promoted = resolve;
  });
  let calls = 0;
  const store = createTelemetryStore({
    retention: { maxEnvelopes: 2 },
    enrichStacktrace: async (_event, { signal }) => {
      if (++calls === 1) return;
      promoted();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  });
  const error = [
    { type: "event" },
    {
      event_id: "duplicate",
      timestamp: 1,
      contexts: { trace: { trace_id: "shared" } },
      exception: { values: [{ type: "Error", value: "test" }] },
    },
  ];
  try {
    await store.ingestEnvelope(envelope(error, 0), { deliveryId: "first" });
    await store.ingestEnvelope(envelope(error, 1), { deliveryId: "promoted" });
    const old = store.ingestEnvelope(
      envelope(transaction("old-generation"), 2),
    );
    await ready;
    store.reset();
    await store.ingestEnvelope(envelope(transaction("fresh"), 3));
    expect(await old).toMatchObject({ status: "ignored", reason: "reset" });
    await store.drain();
    expect(store.getSnapshot().events.map((event) => event.event_id)).toEqual([
      "fresh",
    ]);
    expect(store.getStats().retainedEnvelopes).toBe(1);
    expect(store.getStats().pending).toBe(0);
  } finally {
    store.dispose();
  }
});

test("adding an unrelated profile shares the unchanged immutable profile graph", async () => {
  const store = createTelemetryStore();
  try {
    await store.ingestEnvelope([{}, [transaction("first", "shared"), profile]]);
    const first = store.getProfile("shared");
    expect(first).toBeDefined();
    const otherProfile = [
      profile[0],
      {
        ...(profile[1] as Record<string, unknown>),
        event_id: "other-profile",
        transactions: [{ trace_id: "other", active_thread_id: "main" }],
      },
    ];
    await store.ingestEnvelope([
      {},
      [transaction("second", "other"), otherProfile],
    ]);
    expect(store.getProfile("shared")).toBe(first);
    expect(store.getProfile("other")).toBeDefined();
  } finally {
    store.dispose();
  }
});

test("duplicate error promotion has canonical event order and trace state despite mixed enrichment cache hits", async () => {
  const error = (id: string) => [
    { type: "event" },
    {
      event_id: id,
      timestamp: 1,
      contexts: {
        trace: {
          trace_id: "shared",
          span_id: id,
          status: id === "A" ? "internal_error" : "cancelled",
        },
      },
      exception: { values: [{ type: "Error", value: id }] },
    },
  ];
  const opaque = [{ type: "future" }, { opaque: true }];
  const inputs = [
    envelope(error("A"), 0),
    envelope(opaque, 1),
    [envelope(opaque, 2)[0], [error("A"), error("B")]],
    envelope(opaque, 3),
    envelope(opaque, 4),
  ];
  const calls: string[] = [];
  const store = createTelemetryStore({
    retention: { maxEnvelopes: 3 },
    enrichStacktrace: async (event) => {
      calls.push(event.event_id);
      await Promise.resolve();
    },
  });
  try {
    for (const [index, input] of inputs.entries()) {
      await store.ingestEnvelope(input, { deliveryId: String(index) });
      if (index < 3) continue;
      const canonical = createTelemetryStore({
        retention: { maxEnvelopes: 3 },
        enrichStacktrace: async () => {
          await Promise.resolve();
        },
      });
      try {
        for (let retained = index - 2; retained <= index; retained++)
          await canonical.ingestEnvelope(inputs[retained], {
            deliveryId: String(retained),
          });
        expect(
          store.getSnapshot().events.map((event) => event.event_id),
        ).toEqual(["A", "B"]);
        expect(store.getTrace("shared")).toMatchObject({
          status: "cancelled",
          span_id: "A",
          errors: 2,
        });
        expect({
          ...serializeSnapshot(store.getSnapshot()),
          revision: 0,
        }).toEqual({
          ...serializeSnapshot(canonical.getSnapshot()),
          revision: 0,
        });
      } finally {
        canonical.dispose();
      }
    }
    expect(calls).toEqual(["A", "B", "A"]);
  } finally {
    store.dispose();
  }
});

test("error enrichment stays concurrent and a rejected hook releases later error application", async () => {
  let rejectFirst!: (error: Error) => void;
  let secondEntered!: () => void;
  const ready = new Promise<void>((resolve) => {
    secondEntered = resolve;
  });
  const calls: string[] = [];
  const store = createTelemetryStore({
    enrichStacktrace: async (event) => {
      calls.push(event.event_id);
      if (event.event_id === "first")
        await new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        });
      else {
        secondEntered();
        await Promise.resolve();
      }
    },
  });
  const error = (id: string) => [
    { type: "event" },
    {
      event_id: id,
      timestamp: 1,
      contexts: { trace: { trace_id: "shared", span_id: id } },
      exception: { values: [{ type: "Error", value: id }] },
    },
  ];
  try {
    const operation = store.ingestEnvelope([
      {},
      [error("first"), error("second"), transaction("fast", "shared")],
    ]);
    await ready;
    expect(calls).toEqual(["first", "second"]);
    rejectFirst(new Error("optional source context failed"));
    expect(await operation).toMatchObject({
      status: "processed",
      diagnostics: [{ code: "enrichment_failed" }],
    });
    expect(store.getSnapshot().events.map((event) => event.event_id)).toEqual([
      "fast",
      "first",
      "second",
    ]);
    expect(store.getTrace("shared")?.errors).toBe(2);
  } finally {
    store.dispose();
  }
});

test("a reentrant diagnostic reset releases every error turn and preserves the new generation", async () => {
  let fresh: Promise<unknown> | undefined;
  const store = createTelemetryStore({
    enrichStacktrace: async () => {
      throw new Error("no source context");
    },
    onDiagnostic: (diagnostic) => {
      if (diagnostic.code !== "enrichment_failed" || fresh) return;
      store.reset();
      fresh = store.ingestEnvelope(envelope(transaction("fresh"), 3));
    },
  });
  const error = (id: string) => [
    { type: "event" },
    {
      event_id: id,
      timestamp: 1,
      contexts: { trace: { trace_id: "shared", span_id: id } },
      exception: { values: [{ type: "Error", value: id }] },
    },
  ];
  try {
    expect(
      await store.ingestEnvelope([{}, [error("first"), error("second")]]),
    ).toMatchObject({ status: "ignored", reason: "reset" });
    expect(fresh).toBeDefined();
    await fresh;
    await store.drain();
    expect(store.getSnapshot().events.map((event) => event.event_id)).toEqual([
      "fresh",
    ]);
    expect(store.getStats().pending).toBe(0);
  } finally {
    store.dispose();
  }
});
