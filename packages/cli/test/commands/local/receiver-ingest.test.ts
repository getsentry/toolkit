import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { createLocalControlPlane } from "../../../src/commands/local/control-plane.js";
import { createLocalRetentionBuffer } from "../../../src/commands/local/retention-buffer.js";
import { buildApp } from "../../../src/commands/local/server.js";
import { buildSSEHandler } from "../../../src/commands/local/server.js";
import {
  ingestReceiverEnvelope,
  receiverEnvelopeId,
  drainReceiver,
  createReceiverEnvelope,
} from "../../../src/commands/local/receiver-ingest.js";
import { at } from "../../helpers.js";
import { goPanicEvent } from "../../fixtures/local-sdk-events.js";

const envelope = '{}\n{"type":"event"}\n{"message":"received"}';

test.each([1, 2])(
  "live SSE subscribers receive bursts beyond retention %i without manual flushing",
  async (limit) => {
    const retention = createLocalRetentionBuffer(limit);
    const bodies = Array.from({ length: 8 }, (_, index) =>
      envelope.replace("received", `delivery-${index}`),
    );
    expect(
      await ingestReceiverEnvelope(retention.buffer, {
        body: Buffer.from(at(bodies, 0)),
      }),
    ).toEqual({ status: 200, body: {} });
    const frames: { id?: string; data: string }[] = [];
    const reader = retention.buffer.subscribe(
      buildSSEHandler({
        writeSSE: async (frame) => {
          frames.push(frame);
        },
      }),
    );
    try {
      const statuses = await Promise.all(
        bodies.slice(1).map((body) =>
          ingestReceiverEnvelope(retention.buffer, {
            body: Buffer.from(body),
          }),
        ),
      );
      expect(statuses).toEqual(Array(7).fill({ status: 200, body: {} }));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        frames.map((frame) => JSON.parse(frame.data)[1][0][1].message),
      ).toEqual(bodies.map((_, index) => `delivery-${index}`));
      expect(new Set(frames.map((frame) => frame.id)).size).toBe(8);
      expect(
        retention.buffer
          .read({ all: true })
          .map((item) => item.getData().toString()),
      ).toEqual(bodies.slice(-limit).reverse());
    } finally {
      retention.buffer.unsubscribe(reader);
    }
  },
);

test("raw delivery IDs stay stable across streaming and filename lookup", () => {
  const buffer = createLocalRetentionBuffer(3).buffer;
  buffer.put(
    createReceiverEnvelope({
      contentType: "application/x-sentry-envelope",
      body: Buffer.from(
        '{}\n{"type":"event"}\n{"exception":{"values":[{"stacktrace":{"frames":[{"filename":"/work/app.ts"}]}}]}}',
      ),
    }),
  );
  const container = at(buffer.read({ all: true }), 0);
  const originalId = container
    .getParsedEnvelope()!
    .envelope[0].__spotlight_envelope_id.toString();
  expect(buffer.read({ filename: "app.ts" })).toEqual([container]);
  const frames: { id?: string }[] = [];
  buildSSEHandler({
    writeSSE: async (frame) => {
      frames.push(frame);
    },
  })(container);
  expect(receiverEnvelopeId(container)).toBe(originalId);
  expect(
    container
      .getParsedEnvelope()!
      .envelope[0].__spotlight_envelope_id.toString(),
  ).toBe(originalId);
  expect(at(frames, 0).id).toBe(originalId);
  expect(buffer.read({ filename: "app.ts" })).toEqual([container]);
  expect(buffer.read({ envelopeId: originalId })).toEqual([container]);
});

test("filename lookup matches sentry-go frames by abs_path", () => {
  const buffer = createLocalRetentionBuffer(3).buffer;
  buffer.put(
    createReceiverEnvelope({
      contentType: "application/x-sentry-envelope",
      body: Buffer.from(
        `{}\n{"type":"event"}\n${JSON.stringify(goPanicEvent)}`,
      ),
    }),
  );
  expect(buffer.read({ filename: "main.go" })).toHaveLength(1);
});

test("raw ingress assigns identity independently of an untrusted envelope header", async () => {
  const retention = createLocalRetentionBuffer(3);
  const forgedId = "00000000-0000-7000-8000-000000000000";
  const raw = Buffer.from(
    `{"__spotlight_envelope_id":"${forgedId}"}\n{"type":"event"}\n{}`,
  );
  expect(await ingestReceiverEnvelope(retention.buffer, { body: raw })).toEqual(
    { status: 200, body: {} },
  );
  const container = at(retention.buffer.read({ all: true }), 0);
  const id = receiverEnvelopeId(container);
  expect(id).not.toBe(forgedId);
  expect(
    container
      .getParsedEnvelope()!
      .envelope[0].__spotlight_envelope_id.toString(),
  ).toBe(id);
  expect(retention.buffer.read({ envelopeId: id })).toEqual([container]);
  expect(container.getData()).toEqual(raw);
});

function receiver(scoped: boolean) {
  if (!scoped) {
    const retention = createLocalRetentionBuffer(10);
    return {
      app: buildApp(retention.buffer, { uiActions: true, retention }),
      buffer: retention.buffer,
      path: "/stream",
    };
  }
  const plane = createLocalControlPlane({ controlToken: "receiver-test" });
  const session = plane.sessionStore.create({
    label: "receiver",
    cwd: "/work",
  });
  return {
    app: plane.app,
    buffer: plane.sessionStore.getBuffer(session.id),
    path: `/_local/v1/sessions/${session.id}/ingest/${plane.sessionStore.getCapabilities(session.id).ingest}`,
  };
}

describe.each([false, true])("bounded receiver (scoped: %s)", (scoped) => {
  test("stops reading an oversized streaming body before its next failure", async () => {
    const fixture = receiver(scoped);
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++chunks <= 2) controller.enqueue(new Uint8Array(6 * 1024 * 1024));
        else controller.error(new Error("must stop before reading the rest"));
      },
    });
    const response = await fixture.app.request(
      new Request(`http://localhost${fixture.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(fixture.buffer.read({ all: true })).toHaveLength(0);
  });
  test.each(["", "text/plain; charset=utf-8"])(
    "accepts envelope content type %j",
    async (contentType) => {
      const fixture = receiver(scoped);
      const response = await fixture.app.request(fixture.path, {
        method: "POST",
        headers: contentType ? { "Content-Type": contentType } : {},
        body: new Uint8Array(Buffer.from(envelope)),
      });
      expect(response.status).toBe(200);
      expect(fixture.buffer.read({ all: true })).toHaveLength(1);
      expect(at(fixture.buffer.read({ all: true }), 0).getContentType()).toBe(
        "application/x-sentry-envelope",
      );
    },
  );

  test.each([
    [{ "Content-Type": "application/json" }, envelope, 415],
    [{ "Content-Encoding": "unknown" }, envelope, 415],
    [{ "Content-Encoding": "gzip" }, "corrupt", 400],
  ] as const)(
    "returns controlled errors for %j",
    async (headers, body, status) => {
      const fixture = receiver(scoped);
      const response = await fixture.app.request(fixture.path, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          ...headers,
        },
        body,
      });
      expect(response.status).toBe(status);
      expect(fixture.buffer.read({ all: true })).toHaveLength(0);
    },
  );

  test("bounds decompressed output", async () => {
    const fixture = receiver(scoped);
    const response = await fixture.app.request(fixture.path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "Content-Encoding": "gzip",
      },
      body: new Uint8Array(gzipSync(Buffer.alloc(33 * 1024 * 1024, 120))),
    });
    expect(response.status).toBe(413);
    expect(fixture.buffer.read({ all: true })).toHaveLength(0);
  });
});

// The browser SDK records an http.client span for its own POST to Local and
// sends it in the next envelope, which records another span, and so on.
describe.each([false, true])("own ingest telemetry (scoped: %s)", (scoped) => {
  const receiverOrigin = "http://localhost:8969";
  const traceId = "c0ffee00c0ffee00c0ffee00c0ffee00";
  const attr = (value: string | number) => ({
    type: typeof value === "number" ? "integer" : "string",
    value,
  });
  // Shape of @sentry/core 11.14 fetch spans with span streaming: the name
  // carries only the domain, and the URL is in `url.full`.
  const fetchSpan = (spanId: string, url: string) => {
    const { hostname, port } = new URL(url);
    return {
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: "1111111111111111",
      name: `POST ${hostname}`,
      start_timestamp: 1_767_225_600.1,
      end_timestamp: 1_767_225_600.15,
      status: "ok",
      is_segment: false,
      attributes: {
        "sentry.op": attr("http.client"),
        "sentry.origin": attr("auto.http.browser"),
        "url.full": attr(url),
        type: attr("fetch"),
        "http.request.method": attr("POST"),
        "server.address": attr(hostname),
        "server.port": attr(Number(port)),
        "url.domain": attr(hostname),
        "http.response.status_code": attr(204),
      },
    };
  };
  const spanEnvelope = (spans: unknown[]) =>
    [
      JSON.stringify({
        sent_at: "2026-01-01T00:00:00.200Z",
        sdk: { name: "sentry.javascript.react", version: "11.14.0" },
        trace: { trace_id: traceId, public_key: "public", sampled: "true" },
      }),
      JSON.stringify({
        type: "span",
        item_count: spans.length,
        content_type: "application/vnd.sentry.items.span.v2+json",
      }),
      JSON.stringify({ version: 2, items: spans }),
    ].join("\n");
  const post = (
    fixture: ReturnType<typeof receiver>,
    body: string,
  ): Promise<Response> =>
    Promise.resolve(
      fixture.app.request(
        new Request(`${receiverOrigin}${fixture.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-sentry-envelope" },
          body,
        }),
      ),
    );

  test("does not retain an envelope holding only its own ingest span", async () => {
    const fixture = receiver(scoped);
    const self = `${receiverOrigin}${fixture.path}`;
    const response = await post(
      fixture,
      spanEnvelope([fetchSpan("2222222222222222", self)]),
    );
    expect(response.status).toBe(200);
    // Legacy standalone spans name the full URL and keep it in `data`.
    const legacy = JSON.stringify({
      op: "http.client",
      description: `POST ${self}`,
      span_id: "5555555555555555",
      trace_id: traceId,
      data: { "http.method": "POST", url: self },
    });
    expect((await post(fixture, `{}\n{"type":"span"}\n${legacy}`)).status).toBe(
      200,
    );
    expect(fixture.buffer.read({ all: true })).toHaveLength(0);
  });

  test("keeps the app's spans, including the same path on another port", async () => {
    const fixture = receiver(scoped);
    const self = `${receiverOrigin}${fixture.path}`;
    const appUrl = `http://localhost:5173${fixture.path}`;
    const response = await post(
      fixture,
      spanEnvelope([
        fetchSpan("2222222222222222", self),
        fetchSpan("3333333333333333", appUrl),
        {
          ...fetchSpan("4444444444444444", self),
          attributes: { "sentry.op": attr("resource.fetch") },
        },
      ]),
    );
    expect(response.status).toBe(200);
    const container = at(fixture.buffer.read({ all: true }), 0);
    const [, items] = container.getParsedEnvelope()!.envelope;
    expect(items).toHaveLength(1);
    const [itemHeader, itemPayload] = at(items, 0);
    expect(itemHeader).toMatchObject({ type: "span", item_count: 2 });
    expect(
      (itemPayload["items"] as { span_id: string }[]).map(
        (span) => span.span_id,
      ),
    ).toEqual(["3333333333333333", "4444444444444444"]);
  });

  test("keeps a malformed envelope that mentions its routes byte-exact", async () => {
    const fixture = receiver(scoped);
    const body = `{}\n{"type":"span"}\n{"name":"POST ${receiverOrigin}${fixture.path}"`;
    expect((await post(fixture, body)).status).toBe(200);
    const container = at(fixture.buffer.read({ all: true }), 0);
    expect(container.getData().toString()).toBe(body);
  });

  test("removes its own fetch breadcrumbs from browser errors", async () => {
    const fixture = receiver(scoped);
    const self = `${receiverOrigin}${fixture.path}`;
    const event = JSON.stringify({
      event_id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      platform: "javascript",
      exception: { values: [{ type: "Error", value: "Checkout failed" }] },
      breadcrumbs: [
        {
          type: "http",
          category: "fetch",
          data: { method: "POST", url: self, status_code: 204 },
        },
        {
          type: "http",
          category: "fetch",
          data: { method: "POST", url: "http://localhost:5173/api/orders" },
        },
      ],
    });
    const body = [
      '{"event_id":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}',
      '{"type":"event"}',
      event,
    ].join("\n");
    expect((await post(fixture, body)).status).toBe(200);
    const container = at(fixture.buffer.read({ all: true }), 0);
    expect(container.getData().toString()).not.toContain(self);
    const parsedItems = container.getParsedEnvelope()!.envelope[1];
    const parsedPayload = at(parsedItems, 0)[1];
    expect(parsedPayload).toMatchObject({
      exception: { values: [{ value: "Checkout failed" }] },
      breadcrumbs: [{ data: { url: "http://localhost:5173/api/orders" } }],
    });
  });

  test("removes its own request from transactions and breadcrumbs", async () => {
    // sentry-python records its Spotlight POST inside the active transaction.
    const fixture = receiver(scoped);
    const self = `${receiverOrigin}${fixture.path}`;
    const transaction = JSON.stringify({
      type: "transaction",
      event_id: "dddddddddddddddddddddddddddddddd",
      transaction: "/checkout",
      platform: "python",
      start_timestamp: 1_767_225_600,
      timestamp: 1_767_225_601,
      contexts: {
        trace: {
          trace_id: traceId,
          span_id: "1111111111111111",
          op: "http.server",
        },
      },
      spans: [
        {
          op: "http.client",
          description: `POST ${self}`,
          origin: "auto.http.stdlib.httplib",
          span_id: "2222222222222222",
          parent_span_id: "1111111111111111",
          trace_id: traceId,
          data: { "http.method": "POST", url: self },
        },
        {
          op: "db",
          description: "SELECT * FROM orders",
          span_id: "3333333333333333",
          parent_span_id: "1111111111111111",
          trace_id: traceId,
        },
      ],
      breadcrumbs: {
        values: [
          {
            type: "http",
            category: "httplib",
            data: { method: "POST", url: self },
          },
          {
            type: "default",
            category: "query",
            message: "SELECT * FROM orders",
          },
        ],
      },
    });
    const body = [
      '{"event_id":"dddddddddddddddddddddddddddddddd"}',
      `{"type":"transaction","length":${Buffer.byteLength(transaction)}}`,
      transaction,
    ].join("\n");
    expect((await post(fixture, body)).status).toBe(200);
    const container = at(fixture.buffer.read({ all: true }), 0);
    expect(container.getData().toString()).not.toContain(self);
    const parsedItems2 = container.getParsedEnvelope()!.envelope[1];
    const payload = at(parsedItems2, 0)[1];
    expect(payload["spans"]).toEqual([
      expect.objectContaining({ span_id: "3333333333333333" }),
    ]);
    expect(payload["breadcrumbs"]).toEqual({
      values: [expect.objectContaining({ category: "query" })],
    });
  });
});

describe.each([false, true])("repeated event IDs (scoped: %s)", (scoped) => {
  const eventId = "5c0ffee5c0ffee5c0ffee5c0ffee5c0f";
  const sdk = { name: "sentry.javascript.browser", version: "11.14.0" };
  const lines = (...values: unknown[]) =>
    values.map((value) => JSON.stringify(value)).join("\n");
  const errorEnvelope = lines(
    { event_id: eventId, sent_at: "2026-01-01T00:00:00.000Z", sdk },
    { type: "event" },
    {
      event_id: eventId,
      timestamp: 1_767_225_600,
      platform: "javascript",
      exception: { values: [{ type: "Error", value: "boom" }] },
    },
  );
  const post = (
    fixture: ReturnType<typeof receiver>,
    body: string,
    path = fixture.path,
  ) =>
    Promise.resolve(
      fixture.app.request(
        new Request(`http://localhost:8969${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-sentry-envelope" },
          body,
        }),
      ),
    );
  // Spotlight posts to the ingest URL; a DSN on the same receiver posts to
  // its envelope route.
  const dsnPath = (fixture: ReturnType<typeof receiver>) =>
    scoped ? `${fixture.path}/api/0/envelope/` : "/api/0/envelope/";

  test.each([
    ["error", errorEnvelope],
    [
      "transaction",
      lines(
        { event_id: eventId, sdk },
        { type: "transaction" },
        {
          event_id: eventId,
          type: "transaction",
          transaction: "/checkout",
          start_timestamp: 1_767_225_600,
          timestamp: 1_767_225_601,
          contexts: {
            trace: { trace_id: eventId, span_id: "1111111111111111" },
          },
        },
      ),
    ],
    [
      "feedback",
      lines(
        { event_id: eventId, sdk },
        { type: "feedback" },
        {
          event_id: eventId,
          type: "feedback",
          timestamp: 1_767_225_600,
          contexts: { feedback: { message: "the button does nothing" } },
        },
      ),
    ],
  ])("keeps one %s sent to Spotlight and the DSN", async (_, body) => {
    const fixture = receiver(scoped);
    const seen: string[] = [];
    const reader = fixture.buffer.subscribe((item) =>
      seen.push(item.getData().toString()),
    );
    try {
      const first = await post(fixture, body);
      const second = await post(fixture, body, dsnPath(fixture));
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(await second.json()).toEqual({ id: eventId });
      fixture.buffer.stream(reader);
      expect(fixture.buffer.read({ all: true })).toHaveLength(1);
      expect(seen).toEqual([body]);
    } finally {
      fixture.buffer.unsubscribe(reader);
    }
  });

  test.each([
    [
      // sentry-java and sentry-elixir use the check-in ID as the event ID.
      "check-in statuses",
      ["in_progress", "ok"].map((status) =>
        lines(
          { event_id: eventId, sdk: { name: "sentry.java", version: "8.0.0" } },
          { type: "check_in" },
          { check_in_id: eventId, monitor_slug: "nightly", status },
        ),
      ),
    ],
    [
      "replay segments",
      [0, 1].map((segmentId) =>
        lines(
          { event_id: eventId, sdk },
          { type: "replay_event" },
          {
            type: "replay_event",
            replay_id: eventId,
            segment_id: segmentId,
            timestamp: 1_767_225_600 + segmentId * 5,
          },
          { type: "replay_recording", length: 16 },
          `{"segment_id":${segmentId}}`.padEnd(16),
        ),
      ),
    ],
    [
      "log batches",
      Array(2).fill(
        lines(
          { sent_at: "2026-01-01T00:00:00.000Z", sdk },
          {
            type: "log",
            item_count: 1,
            content_type: "application/vnd.sentry.items.log+json",
          },
          {
            items: [
              {
                timestamp: 1_767_225_600,
                level: "info",
                body: "same line",
                trace_id: eventId,
              },
            ],
          },
        ),
      ),
    ],
    [
      "span batches",
      Array(2).fill(
        lines(
          { sdk, trace: { trace_id: eventId, public_key: "public" } },
          {
            type: "span",
            item_count: 1,
            content_type: "application/vnd.sentry.items.span.v2+json",
          },
          {
            version: 2,
            items: [
              {
                trace_id: eventId,
                span_id: "2222222222222222",
                name: "work",
                start_timestamp: 1_767_225_600,
                end_timestamp: 1_767_225_601,
                is_segment: true,
              },
            ],
          },
        ),
      ),
    ],
  ])("keeps both %s", async (_, bodies: string[]) => {
    const fixture = receiver(scoped);
    for (const body of bodies) {
      expect((await post(fixture, body)).status).toBe(200);
    }
    expect(
      fixture.buffer
        .read({ all: true })
        .map((item) => item.getData().toString())
        .reverse(),
    ).toEqual(bodies);
  });

  test("keeps an event again once its first copy is cleared", async () => {
    const fixture = receiver(scoped);
    await post(fixture, errorEnvelope);
    fixture.buffer.clear();
    await post(fixture, errorEnvelope);
    expect(fixture.buffer.read({ all: true })).toHaveLength(1);
  });
});

test("keeps an event again once its first copy is evicted", async () => {
  const retention = createLocalRetentionBuffer(2);
  const seen: string[] = [];
  const reader = retention.buffer.subscribe((item) =>
    seen.push(JSON.parse(item.getData().toString().split("\n")[2]!).message),
  );
  for (const id of ["a", "a", "b", "c", "a"]) {
    await ingestReceiverEnvelope(retention.buffer, {
      body: Buffer.from(
        `{"event_id":"${id.repeat(32)}"}\n{"type":"event"}\n{"message":"${id}"}`,
      ),
    });
  }
  retention.buffer.unsubscribe(reader);
  expect(seen).toEqual(["a", "b", "c", "a"]);
});

test.each([
  "{}\nnot-an-item-header\n{}",
  '{}\n{"type":"event","length":99}\n{}',
  "{}\n[]\n{}",
  '{}\n{"type":"event"}\nfalse',
])(
  "retains malformed raw delivery %j with a downloadable stable ID",
  async (body) => {
    const plane = createLocalControlPlane({ controlToken: "raw-test" });
    const session = plane.sessionStore.create({ label: "raw", cwd: "/work" });
    const ingest = `/_local/v1/sessions/${session.id}/ingest/${plane.sessionStore.getCapabilities(session.id).ingest}`;
    const response = await plane.app.request(ingest, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body,
    });

    expect(response.status).toBe(200);
    const headers = { Authorization: "Bearer raw-test" };
    const base = `/_local/v1/sessions/${session.id}`;
    const listing = await plane.app.request(`${base}/envelopes`, { headers });
    expect(listing.status).toBe(200);
    const { envelopes } = (await listing.json()) as {
      envelopes: { id: string }[];
    };
    expect(envelopes).toHaveLength(1);
    expect(at(envelopes, 0).id).toMatch(/^[a-f\d-]{36}$/);
    const raw = await plane.app.request(
      `${base}/envelopes/${at(envelopes, 0).id}`,
      { headers },
    );
    expect(raw.status).toBe(200);
    expect(
      Buffer.from(
        ((await raw.json()) as { data: string }).data,
        "base64",
      ).toString(),
    ).toBe(body);
    expect(
      await (await plane.app.request(`${base}/events`, { headers })).json(),
    ).toEqual({ events: [] });
    const accepted = await plane.app.request(ingest, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: envelope,
    });
    expect(accepted.status).toBe(200);
    expect(
      plane.sessionStore.getBuffer(session.id).read({ all: true }),
    ).toHaveLength(2);
  },
);

test("clear cancels preceding admissions and preserves live subscribers and settings", async () => {
  const retention = createLocalRetentionBuffer(3);
  const seen: string[] = [];
  const reader = retention.buffer.subscribe((item) =>
    seen.push(item.getData().toString()),
  );
  const before = ingestReceiverEnvelope(retention.buffer, {
    body: Buffer.from(envelope),
  });
  retention.buffer.clear();
  expect(await before).toBe(503);
  const after = envelope.replace("received", "after-clear");
  expect(
    await ingestReceiverEnvelope(retention.buffer, {
      body: Buffer.from(after),
    }),
  ).toEqual({ status: 200, body: {} });
  retention.buffer.stream(reader);
  retention.buffer.stream(reader);
  expect(seen).toEqual([after]);
  expect(retention.getSettings()).toEqual({
    maxEnvelopes: 3,
    retainedEnvelopes: 1,
  });
  retention.buffer.unsubscribe(reader);
});

test.each(["clear", "reset"] as const)(
  "%s keeps invalidated admissions counted until they settle",
  async (method) => {
    const retention = createLocalRetentionBuffer(3);
    const active = ingestReceiverEnvelope(retention.buffer, {
      body: gzipSync(envelope),
      encoding: "gzip",
    });
    await Promise.resolve();
    const queued = Array.from({ length: 63 }, () =>
      ingestReceiverEnvelope(retention.buffer, { body: Buffer.from(envelope) }),
    );
    retention.buffer[method]();
    const overflow = ingestReceiverEnvelope(retention.buffer, {
      body: Buffer.from(envelope),
    });
    expect(await overflow).toBe(503);
    expect(await active).toBe(503);
    expect(await Promise.all(queued)).toEqual(Array(63).fill(503));
    expect(retention.buffer.read({ all: true })).toHaveLength(0);
    expect(
      await ingestReceiverEnvelope(retention.buffer, {
        body: Buffer.from(envelope),
      }),
    ).toEqual({ status: 200, body: {} });
  },
);

test("retention changes include preceding compressed admissions and preserve cursors", async () => {
  const retention = createLocalRetentionBuffer(3);
  const writes = ["one", "two"].map((name) =>
    ingestReceiverEnvelope(retention.buffer, {
      body: gzipSync(envelope.replace("received", name)),
      encoding: "gzip",
    }),
  );
  await expect(retention.resize(1)).rejects.toThrow(/2 retained envelopes/);
  expect(await Promise.all(writes)).toEqual([
    { status: 200, body: {} },
    { status: 200, body: {} },
  ]);
  const history = retention.buffer.read({ all: true });
  const cursor = receiverEnvelopeId(at(history, 1));
  const seen: string[] = [];
  const reader = retention.buffer.subscribe(
    (item) => seen.push(item.getData().toString()),
    cursor,
  );
  await retention.resize(5);
  await retention.resize(4);
  retention.buffer.stream(reader);
  expect(seen).toEqual([envelope.replace("received", "two")]);
  retention.buffer.unsubscribe(reader);
});

test("close drains an admitted decode before its final SSE lifecycle frame", async () => {
  const plane = createLocalControlPlane({ controlToken: "close-test" });
  const session = plane.sessionStore.create({
    label: "close",
    cwd: "/work",
  });
  const buffer = plane.sessionStore.getBuffer(session.id);
  const stream = await plane.app.request(
    `/_local/v1/sessions/${session.id}/stream?cap=${plane.sessionStore.getCapabilities(session.id).stream}`,
  );
  const reading = stream.text();
  const writing = ingestReceiverEnvelope(buffer, {
    body: gzipSync(envelope),
    encoding: "gzip",
  });
  plane.sessionStore.close(session.id);
  expect(await writing).toEqual({ status: 200, body: {} });
  const text = await reading;
  expect(text).toContain("received");
  expect(text.indexOf("received")).toBeLessThan(
    text.indexOf('"state":"retained"'),
  );
});

test("raw attachments remain byte exact and malformed SSE remains inspectable with a cursor", async () => {
  const retention = createLocalRetentionBuffer(3);
  const attachment = Buffer.from([0, 255, 10, 128, 120]);
  const body = Buffer.concat([
    Buffer.from(
      `{}\n{"type":"attachment","filename":"binary.bin","length":${attachment.length}}\n`,
    ),
    attachment,
  ]);
  expect(await ingestReceiverEnvelope(retention.buffer, { body })).toEqual({
    status: 200,
    body: {},
  });
  expect(at(retention.buffer.read({ all: true }), 0).getData()).toEqual(body);
  const malformed = Buffer.from("{}\nnot-an-item-header\n");
  expect(
    await ingestReceiverEnvelope(retention.buffer, { body: malformed }),
  ).toEqual({ status: 200, body: {} });
  const latest = at(retention.buffer.read({ all: true }), 0);
  const frames: { id?: string; data: string }[] = [];
  const handler = buildSSEHandler({
    writeSSE: async (frame) => {
      frames.push(frame);
    },
  });
  handler(latest);
  expect(frames).toEqual([
    {
      id: receiverEnvelopeId(latest),
      event: "application/x-sentry-envelope",
      data: malformed.toString(),
    },
  ]);
  expect(
    retention.buffer.read({ envelopeId: receiverEnvelopeId(latest) })[0],
  ).toBe(latest);
  await drainReceiver(retention.buffer);
});

test("malformed exception metadata cannot break raw filename queries", async () => {
  const retention = createLocalRetentionBuffer();
  const body = Buffer.from(
    '{}\n{"type":"event"}\n{"exception":{"values":"malformed"}}',
  );
  expect(await ingestReceiverEnvelope(retention.buffer, { body })).toEqual({
    status: 200,
    body: {},
  });
  expect(retention.buffer.read({ filename: "app.ts" })).toEqual([]);
  expect(at(retention.buffer.read({ all: true }), 0).getData()).toEqual(body);
});

test("SSE falls back to raw data if deeply nested decoded JSON cannot serialize", async () => {
  const retention = createLocalRetentionBuffer();
  const raw =
    '{}\n{"type":"event"}\n{"nested":' +
    "[".repeat(12000) +
    "0" +
    "]".repeat(12000) +
    "}";
  expect(
    await ingestReceiverEnvelope(retention.buffer, { body: Buffer.from(raw) }),
  ).toEqual({ status: 200, body: {} });
  const frames: { data: string }[] = [];
  buildSSEHandler({
    writeSSE: async (frame) => {
      frames.push(frame);
    },
  })(at(retention.buffer.read({ all: true }), 0));
  expect(frames).toHaveLength(1);
  expect(at(frames, 0).data).toBe(raw);
});
