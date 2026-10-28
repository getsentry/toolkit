// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import * as core from "./index.ts";

function spans(id: string, traceId = "trace", count = 1) {
  return [
    {
      __spotlight_envelope_id: id,
      sdk: { name: "sentry.javascript.node", version: "11" },
    },
    [
      [
        { type: "span" },
        {
          version: 2,
          items: Array.from({ length: count }, (_, index) => ({
            trace_id: traceId,
            span_id: `${id}-${index}`,
            name: "SELECT 1",
            start_timestamp: 1,
            end_timestamp: 1.125,
            attributes: { "sentry.op": { value: "db.query", type: "string" } },
          })),
        },
      ],
    ],
  ];
}
afterEach(() => vi.useRealTimers());

test("canonical reads have consistent filters and explicit summary units", async () => {
  const client = core.createTelemetryStore();
  const result = await client.ingestEnvelope(spans("one"));
  expect(result).toMatchObject({
    status: "processed",
    envelopeId: "one",
    diagnostics: [],
  });
  expect(client.getDatabaseQuerySummaries({ traceId: "trace" })).toMatchObject([
    { count: 1, totalDurationMs: 125, averageDurationMs: 125 },
  ]);
  expect(client.getTrace("trace")?.spans.size).toBe(1);
  expect(client.getSpans({ traceId: "absent" })).toEqual([]);
  expect(client.getDatabaseQuerySummaries({ traceId: "absent" })).toEqual([]);
  expect(client).not.toHaveProperty("store");
  client.dispose();
});

test("subscribers see exactly one coherent update per ingestion", async () => {
  const client = core.createTelemetryStore();
  const seen: number[] = [];
  client.subscribe((snapshot) => {
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.traces).toHaveLength(1);
    expect(client.getDatabaseQuerySummaries()[0].count).toBe(3);
    seen.push(snapshot.revision);
  });
  const initial = client.getSnapshot();
  await client.ingestEnvelope(spans("three", "trace", 3));
  expect(seen).toHaveLength(1);
  expect(client.getSnapshot()).toBe(client.getSnapshot());
  expect(initial.events).toEqual([]);
  client.dispose();
});

test("returned events, nested maps and earlier snapshots cannot mutate engine state", async () => {
  const client = core.createTelemetryStore();
  await client.ingestEnvelope(spans("one"));
  const snapshot = client.getSnapshot();
  const trace = client.getTrace("trace")!;
  expect(() => (trace.spans as Map<string, unknown>).clear()).toThrow();
  expect(() => {
    (trace.spans.values().next().value as { description: string }).description =
      "changed";
  }).toThrow();
  expect(() => (client.getEvents() as unknown[]).pop()).toThrow();
  trace.spans.forEach((_value, _key, map) =>
    expect(() => (map as Map<string, unknown>).clear()).toThrow(),
  );
  await client.ingestEnvelope(spans("two"));
  expect(snapshot.traces[0].spans.size).toBe(1);
  expect(client.getTrace("trace")?.spans.size).toBe(2);
  expect(client.getDatabaseQuerySummaries()[0].description).toBe("SELECT 1");
  client.dispose();
});

test("snapshots preserve own prototype-named JSON fields without inheriting their values", async () => {
  const client = core.createTelemetryStore();
  const input = JSON.parse(
    '[{"__spotlight_envelope_id":"proto"},[[{"type":"event"},{"event_id":"proto","timestamp":1,"extra":{"__proto__":{"unexpected":true},"kept":1}}]]]',
  );
  expect(await client.ingestEnvelope(input)).toMatchObject({
    status: "processed",
  });
  const extra = client.getEvent("proto")!.extra!;
  expect(Object.hasOwn(extra, "__proto__")).toBe(true);
  expect(extra.unexpected).toBeUndefined();
  expect(JSON.stringify(client.getEnvelope("proto"))).toBe(
    JSON.stringify(input),
  );
  expect(() => {
    (extra.__proto__ as { unexpected: boolean }).unexpected = false;
  }).toThrow();
  client.dispose();
});

test("invalid and unsupported envelopes return diagnostics without changing the snapshot", async () => {
  const client = core.createTelemetryStore();
  const initial = client.getSnapshot();
  expect(await client.ingestEnvelope(null)).toMatchObject({
    status: "invalid",
    diagnostics: [{ code: "invalid_envelope" }],
  });
  expect(client.getSnapshot()).toBe(initial);
  expect(
    await client.ingestEnvelope([{}, [[{ type: "future" }, {}]]]),
  ).toMatchObject({
    status: "ignored",
    reason: "unsupported_items",
  });
  expect(await client.ingestEnvelope(spans("duplicate"))).toMatchObject({
    status: "processed",
  });
  const snapshot = client.getSnapshot();
  expect(await client.ingestEnvelope(spans("duplicate"))).toMatchObject({
    status: "ignored",
    reason: "duplicate",
  });
  expect(client.getSnapshot()).toBe(snapshot);
  client.dispose();
});

test("invalid parsed input reports the same diagnostic to the observer and caller", async () => {
  const diagnostics: string[] = [];
  const client = core.createTelemetryStore({
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
  });
  const result = await client.ingestEnvelope(null);
  expect(diagnostics).toEqual(["invalid_envelope"]);
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
    diagnostics,
  );
  client.dispose();
});

test("a rejected envelope waits for sibling enrichment and cannot poison later events", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let enrichments = 0;
  const client = core.createTelemetryStore({
    enrichStacktrace: async (event) => {
      enrichments++;
      if (enrichments === 1) {
        entered();
        await gate;
      }
      event.exception.values![0].value =
        enrichments === 1 ? "invalid-cached" : "valid-context";
    },
  });
  const error = {
    event_id: "same",
    timestamp: 1,
    exception: { values: [{ type: "Error", value: "original" }] },
  };
  const pending = client.ingestEnvelope([
    {},
    [
      [{ type: "event" }, error],
      [{ type: "log" }, { items: [null] }],
    ],
  ]);
  await ready;
  let finished = false;
  void pending.then(() => {
    finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  release();
  expect(await pending).toMatchObject({ status: "invalid" });
  expect(client.getEvents()).toEqual([]);
  await client.ingestEnvelope([{}, [[{ type: "event" }, error]]]);
  expect(enrichments).toBe(2);
  expect(client.getErrors()[0].exception.values?.[0].value).toBe(
    "valid-context",
  );
  client.dispose();
});

test("malformed spans have diagnostics while mixed valid spans still process", async () => {
  const client = core.createTelemetryStore();
  expect(
    await client.ingestEnvelope([
      {},
      [[{ type: "span" }, { version: 2, items: [{}] }]],
    ]),
  ).toMatchObject({
    status: "invalid",
    diagnostics: [{ code: "invalid_span" }],
  });
  const input = spans("partial");
  (input[1][0][1] as { items: unknown[] }).items.push({});
  expect(await client.ingestEnvelope(input)).toMatchObject({
    status: "processed",
    diagnostics: [{ code: "invalid_span" }],
  });
  expect(client.getSpans()).toHaveLength(1);
  client.dispose();
});

test("retention preserves identities of profile spans derived from retained envelopes", async () => {
  const { readFileSync } = await import("node:fs");
  const { createTelemetryPipeline } = await import("../sdk/node.ts");
  const client = createTelemetryPipeline({ retention: { maxEnvelopes: 3 } });
  await client.ingestEnvelope(spans("evict-me"));
  for (const file of ["transaction.txt", "profile_chunk_1.txt"]) {
    const body = readFileSync(
      new URL(`../../_fixtures/continuous_profiling/${file}`, import.meta.url),
    );
    const result = await client.ingestPayload({ body });
    expect(result.status).toBe("processed");
  }
  const traceId = "f1e2d3c4b5a6978012345678901234ab";
  const ids = client.getSpans({ traceId }).map((span) => span.span_id);
  expect(
    client
      .getSpans({ traceId })
      .some((span) => span.tags?.source === "profile"),
  ).toBe(true);
  await client.ingestEnvelope(spans("new"));
  expect(client.getSpans({ traceId }).map((span) => span.span_id)).toEqual(ids);
  client.dispose();
});

test("count retention evicts related events, traces, logs and profiles coherently", async () => {
  const client = core.createTelemetryStore({ retention: { maxEnvelopes: 1 } });
  await client.ingestEnvelope([
    { __spotlight_envelope_id: "old" },
    [
      [
        { type: "log" },
        {
          items: [
            { body: "old", timestamp: 1, trace_id: "old", attributes: {} },
          ],
        },
      ],
      [
        { type: "span" },
        {
          version: 2,
          items: [
            {
              trace_id: "old",
              span_id: "old",
              name: "SELECT old",
              start_timestamp: 1,
              end_timestamp: 2,
              attributes: { "sentry.op": { value: "db" } },
            },
          ],
        },
      ],
    ],
  ]);
  await client.ingestEnvelope(spans("new", "new"));
  expect(client.getEnvelopes()).toHaveLength(1);
  expect(client.getTrace("old")).toBeUndefined();
  expect(client.getLogs({ traceId: "old" })).toEqual([]);
  expect(client.getEvents()).toHaveLength(1);
  expect(client.getDatabaseQuerySummaries()).toMatchObject([
    { description: "SELECT 1", count: 1 },
  ]);
  client.dispose();
});

test("retention replay preserves generated log IDs and does not repeat enrichment", async () => {
  let enrichments = 0;
  const client = core.createTelemetryStore({
    retention: { maxEnvelopes: 2 },
    enrichStacktrace: async () => {
      enrichments++;
    },
  });
  await client.ingestEnvelope(spans("first"));
  await client.ingestEnvelope([
    { __spotlight_envelope_id: "retained" },
    [
      [
        { type: "log" },
        { items: [{ body: "hello", timestamp: 1, attributes: {} }] },
      ],
      [
        { type: "event" },
        {
          event_id: "error",
          timestamp: 1,
          exception: { values: [{ type: "Error", value: "error" }] },
        },
      ],
    ],
  ]);
  const id = client.getLogs()[0].id;
  await client.ingestEnvelope(spans("last"));
  expect(client.getLogs()[0].id).toBe(id);
  expect(enrichments).toBe(1);
  expect(client.getErrors()).toHaveLength(1);
  client.dispose();
});

test("duplicate error IDs have one deterministic enrichment owner across replay", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const client = core.createTelemetryStore({
    retention: { maxEnvelopes: 2 },
    enrichStacktrace: async () => {
      calls++;
      if (calls === 1) {
        entered();
        await gate;
      }
    },
  });
  await client.ingestEnvelope(spans("old"));
  const pending = client.ingestEnvelope([
    { __spotlight_envelope_id: "keep" },
    ["first", "second"].map((value) => [
      { type: "event" },
      {
        event_id: "same",
        timestamp: 1,
        exception: { values: [{ type: "Error", value }] },
      },
    ]),
  ]);
  await ready;
  release();
  await pending;
  expect(calls).toBe(1);
  expect(client.getErrors()[0].exception.values?.[0].value).toBe("first");
  await client.ingestEnvelope(spans("new"));
  expect(client.getErrors()[0].exception.values?.[0].value).toBe("first");
  expect(calls).toBe(1);
  client.dispose();
});

test("evicting an error owner enriches the retained duplicate from its own exception", async () => {
  const seen: string[] = [];
  const client = core.createTelemetryStore({
    retention: { maxEnvelopes: 3 },
    enrichStacktrace: async (event) => {
      const exception = event.exception.values![0];
      seen.push(exception.value!);
      exception.value = `enriched:${exception.value}`;
    },
  });
  for (const id of ["old", "retained"]) {
    await client.ingestEnvelope([
      { __spotlight_envelope_id: id },
      [
        [
          { type: "event" },
          {
            event_id: "same",
            timestamp: 1,
            exception: { values: [{ value: id }] },
          },
        ],
      ],
    ]);
    if (id === "old") await client.ingestEnvelope(spans("middle"));
  }
  expect(client.getErrors()[0].exception.values![0].value).toBe("enriched:old");
  await client.ingestEnvelope(spans("new"));
  expect(client.getErrors()[0].exception.values![0].value).toBe(
    "enriched:retained",
  );
  expect(seen).toEqual(["old", "retained"]);
  await client.ingestEnvelope(spans("next"));
  expect(seen).toEqual(["old", "retained"]);
  client.dispose();
});

test("SDK last-seen times do not advance when retained envelopes replay", async () => {
  vi.useFakeTimers();
  const client = core.createTelemetryStore({ retention: { maxEnvelopes: 2 } });
  for (const [index, name] of ["old", "keep", "new"].entries()) {
    vi.setSystemTime(1000 * (index + 1));
    await client.ingestEnvelope([
      { __spotlight_envelope_id: name },
      [
        [
          { type: "event" },
          { event_id: name, timestamp: 1, sdk: { name, version: "1" } },
        ],
      ],
    ]);
  }
  expect(client.getSdks().find((sdk) => sdk.name === "keep")?.lastSeen).toBe(
    2000,
  );
  client.dispose();
});

test("age retention expires while idle and disposes its timer", async () => {
  vi.useFakeTimers();
  const client = core.createTelemetryStore({ retention: { maxAgeMs: 1000 } });
  await client.ingestEnvelope(spans("old"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(client.getTraces()).toEqual([]);
  expect(client.getEnvelopes()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  await client.ingestEnvelope(spans("new"));
  client.dispose();
  expect(vi.getTimerCount()).toBe(0);
  expect(await client.ingestEnvelope(spans("closed"))).toMatchObject({
    status: "ignored",
    reason: "disposed",
  });
});

test("reset invalidates active and queued work while allowing immediate new ingestion", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const client = core.createTelemetryStore({
    enrichStacktrace: () => {
      entered();
      return gate;
    },
  });
  const active = client.ingestEnvelope([
    { __spotlight_envelope_id: "error" },
    [
      [
        { type: "event" },
        { event_id: "error", timestamp: 1, exception: { values: [] } },
      ],
    ],
  ]);
  await ready;
  const queued = client.ingestEnvelope(spans("queued"));
  client.reset();
  await client.ingestEnvelope(spans("new"));
  expect(client.getEvents()).toHaveLength(1);
  release();
  expect(await active).toMatchObject({ status: "ignored", reason: "reset" });
  expect(await queued).toMatchObject({ status: "ignored", reason: "reset" });
  expect(client.getEvents()).toHaveLength(1);
  expect(client.getErrors()).toEqual([]);
  client.dispose();
});

test("subscribers can reset without a later notification restoring stale state", async () => {
  const client = core.createTelemetryStore();
  let reset = false;
  const observed: number[] = [];
  client.subscribe((snapshot) => {
    if (!reset && snapshot.events.length) {
      reset = true;
      client.reset();
    }
  });
  client.subscribe((snapshot) => observed.push(snapshot.events.length));
  await client.ingestEnvelope(spans("old"));
  expect(client.getTraces()).toEqual([]);
  expect(observed).toEqual([0]);
  client.dispose();
});
