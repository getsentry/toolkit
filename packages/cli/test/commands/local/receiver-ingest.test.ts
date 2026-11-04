import { gzipSync } from "node:zlib";
import {
  createSpotlightBuffer,
  pushToSpotlightBuffer,
} from "@spotlightjs/spotlight/sdk";
import { describe, expect, test } from "vitest";
import { createLocalControlPlane } from "../../../src/commands/local/control-plane.js";
import { createLocalRetentionBuffer } from "../../../src/commands/local/retention-buffer.js";
import { buildApp } from "../../../src/commands/local/server.js";
import { buildSSEHandler } from "../../../src/commands/local/server.js";
import {
  ingestReceiverEnvelope,
  receiverEnvelopeId,
  drainReceiver,
} from "../../../src/commands/local/receiver-ingest.js";

const envelope = '{}\n{"type":"event"}\n{"message":"received"}';

test("adopting an indexed SDK container preserves its ID and filename index", () => {
  const sdk = createSpotlightBuffer(3);
  pushToSpotlightBuffer({
    spotlightBuffer: sdk,
    contentType: "application/x-sentry-envelope",
    body: Buffer.from(
      '{}\n{"type":"event"}\n{"exception":{"values":[{"stacktrace":{"frames":[{"filename":"/work/app.ts"}]}}]}}',
    ),
  });
  const container = sdk.read({ all: true })[0]!;
  const originalId = container
    .getParsedEnvelope()!
    .envelope[0].__spotlight_envelope_id.toString();
  expect(sdk.read({ filename: "app.ts" })).toEqual([container]);
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
  expect(frames[0]!.id).toBe(originalId);
  expect(sdk.read({ filename: "app.ts" })).toEqual([container]);
  expect(sdk.read({ envelopeId: originalId })).toEqual([container]);
});

test("raw ingress assigns identity independently of an untrusted envelope header", async () => {
  const retention = createLocalRetentionBuffer(3);
  const forgedId = "00000000-0000-7000-8000-000000000000";
  const raw = Buffer.from(
    `{"__spotlight_envelope_id":"${forgedId}"}\n{"type":"event"}\n{}`,
  );
  expect(await ingestReceiverEnvelope(retention.buffer, { body: raw })).toBe(
    204,
  );
  const container = retention.buffer.read({ all: true })[0]!;
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
      expect(response.status).toBe(204);
      expect(fixture.buffer.read({ all: true })).toHaveLength(1);
      expect(fixture.buffer.read({ all: true })[0]!.getContentType()).toBe(
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

test.each([
  "not-json",
  '1\n{"type":"event"}\n{}',
  '[]\n{"type":"event"}\n{}',
  '{}\n{"type":"event"}\nnot-json',
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

    expect(response.status).toBe(204);
    const headers = { Authorization: "Bearer raw-test" };
    const base = `/_local/v1/sessions/${session.id}`;
    const listing = await plane.app.request(`${base}/envelopes`, { headers });
    expect(listing.status).toBe(200);
    const { envelopes } = (await listing.json()) as {
      envelopes: { id: string }[];
    };
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.id).toMatch(/^[a-f\d-]{36}$/);
    const raw = await plane.app.request(
      `${base}/envelopes/${envelopes[0]!.id}`,
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
    expect(accepted.status).toBe(204);
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
  ).toBe(204);
  retention.buffer.stream(reader);
  retention.buffer.stream(reader);
  expect(seen).toEqual([after]);
  expect(retention.getSettings()).toEqual({
    maxEnvelopes: 3,
    retainedEnvelopes: 1,
  });
  retention.buffer.unsubscribe(reader);
});

test("retention changes include preceding compressed admissions and preserve cursors", async () => {
  const retention = createLocalRetentionBuffer(3);
  const writes = ["one", "two"].map((name) =>
    ingestReceiverEnvelope(retention.buffer, {
      body: gzipSync(envelope.replace("received", name)),
      encoding: "gzip",
    }),
  );
  await expect(retention.resize(1)).rejects.toThrow(/2 retained envelopes/);
  expect(await Promise.all(writes)).toEqual([204, 204]);
  const history = retention.buffer.read({ all: true });
  const cursor = receiverEnvelopeId(history[1]!);
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
  expect(await writing).toBe(204);
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
  expect(await ingestReceiverEnvelope(retention.buffer, { body })).toBe(204);
  expect(retention.buffer.read({ all: true })[0]!.getData()).toEqual(body);
  const malformed = Buffer.from("not-an-envelope");
  expect(
    await ingestReceiverEnvelope(retention.buffer, { body: malformed }),
  ).toBe(204);
  const latest = retention.buffer.read({ all: true })[0]!;
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
  expect(await ingestReceiverEnvelope(retention.buffer, { body })).toBe(204);
  expect(retention.buffer.read({ filename: "app.ts" })).toEqual([]);
  expect(retention.buffer.read({ all: true })[0]!.getData()).toEqual(body);
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
  ).toBe(204);
  const frames: { data: string }[] = [];
  buildSSEHandler({
    writeSSE: async (frame) => {
      frames.push(frame);
    },
  })(retention.buffer.read({ all: true })[0]!);
  expect(frames).toHaveLength(1);
  expect(frames[0]!.data).toBe(raw);
});
