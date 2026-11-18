import { gzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { createReceiverEnvelope } from "../../../src/commands/local/envelope.js";
import {
  prepareReceiverEnvelope,
  receiverEnvelopeId,
} from "../../../src/commands/local/receiver-ingest.js";
import { envelopeReceivedAt } from "../../../src/commands/local/viewer-protocol.js";

describe("receiver envelope codec", () => {
  test("preserves binary framing and JSON byte lengths across multiple items", () => {
    const attachment = Buffer.from([0, 255, 10, 128, 123, 125]);
    const event = Buffer.from('{"type":"forged","message":"café\\nreceived"}');
    const body = Buffer.concat([
      Buffer.from(`{}\n{"type":"attachment","length":${attachment.length}}\n`),
      attachment,
      Buffer.from(`\n{"type":"event","length":${event.length}}\n`),
      event,
      Buffer.from('\n{"type":"log"}\n{"items":[]}\n'),
    ]);
    const container = createReceiverEnvelope({ body, userAgent: "test-sdk" });
    const parsed = container.getParsedEnvelope();
    expect(container.getData()).toBe(body);
    expect(parsed?.envelope[1]).toEqual([
      [
        { type: "attachment", length: attachment.length },
        { data: attachment.toString("base64") },
      ],
      [
        { type: "event", length: event.length },
        { message: "café\nreceived", type: "event" },
      ],
      [{ type: "log" }, { items: [], type: "log" }],
    ]);
    expect(parsed?.envelope[0]["__spotlight_sender_user_agent"]).toBe(
      "test-sdk",
    );
    expect(container.getParsedEnvelope()).toBe(parsed);
    expect(container.getEventTypes()).toEqual(["attachment", "event", "log"]);
  });

  test.each(["", "hello\n世界"])(
    "retains explicit-length text attachments %j",
    (text) => {
      const payload = Buffer.from(text);
      const container = createReceiverEnvelope({
        body: Buffer.concat([
          Buffer.from(
            `{}\n{"type":"attachment","content_type":"text/plain","length":${payload.length}}\n`,
          ),
          payload,
        ]),
      });
      expect(container.getParsedEnvelope()?.envelope[1][0]?.[1]).toEqual({
        data: text,
      });
    },
  );

  test.each([
    "not-json",
    '[]\n{"type":"event"}\n{}',
    "{}\n[]\n{}",
    '{}\n{"type":"event"}\nfalse',
    '{}\n{"type":"event"}\n[]',
    '{}\n{"type":"event"}\nnull',
    '{}\n{"type":"event"}\n',
    '{}\n{"type":"event","length":-1}\n{}',
    '{}\n{"type":"event","length":1.5}\n{}',
    '{}\n{"type":"event","length":"2"}\n{}',
    '{}\n{"type":"attachment","length":100}\nshort',
    '{}\n{"type":"event","length":2}\n{}junk',
  ])("keeps malformed bytes without exposing decoded indexes: %j", (raw) => {
    const body = Buffer.from(raw);
    const container = createReceiverEnvelope({ body });
    expect(container.getParsedEnvelope()).toBeNull();
    expect(container.getEventTypes()).toBeNull();
    expect(container.getData()).toBe(body);
    const id = receiverEnvelopeId(container);
    expect(id).toMatch(/^[a-f\d-]{36}$/);
    expect(prepareReceiverEnvelope(container)).toBe(id);
  });

  test("IDs record when the receiver accepted the envelope", () => {
    const before = Date.now();
    const container = createReceiverEnvelope({ body: Buffer.from("{}\n") });
    const receivedAt = envelopeReceivedAt(prepareReceiverEnvelope(container));
    expect(receivedAt).toBeGreaterThanOrEqual(before);
    expect(receivedAt).toBeLessThanOrEqual(Date.now());
    expect(envelopeReceivedAt("not-a-uuid")).toBeUndefined();
  });

  test("decodes a browser replay segment around its gzip recording", () => {
    // Shape from @sentry-internal/replay: a JSON replay_event, then a
    // replay_recording of `{"segment_id":N}\n` followed by gzip bytes.
    const replayId = "4d1c5b0e9a3f4c7e8b2a6f1d0c9e8b7a";
    const replayEvent = Buffer.from(
      JSON.stringify({
        type: "replay_event",
        replay_id: replayId,
        event_id: replayId,
        replay_type: "session",
        segment_id: 0,
        timestamp: 1_767_225_605.1,
        replay_start_timestamp: 1_767_225_600.2,
        urls: ["http://localhost:5173/"],
        platform: "javascript",
      }),
    );
    const recording = Buffer.concat([
      Buffer.from('{"segment_id":0}\n'),
      gzipSync(
        JSON.stringify([
          { type: 4, timestamp: 1_767_225_600_200, data: { href: "/" } },
        ]),
      ),
    ]);
    const body = Buffer.concat([
      Buffer.from(
        `{"event_id":"${replayId}","sent_at":"2026-01-01T00:00:05.100Z","sdk":{"name":"sentry.javascript.react","version":"11.14.0"}}\n`,
      ),
      Buffer.from('{"type":"replay_event"}\n'),
      replayEvent,
      Buffer.from(
        `\n{"type":"replay_recording","length":${recording.length}}\n`,
      ),
      recording,
    ]);
    const container = createReceiverEnvelope({ body });
    expect(container.getEventTypes()).toEqual([
      "replay_event",
      "replay_recording",
    ]);
    const [event, raw] = container.getParsedEnvelope()?.envelope[1] ?? [];
    expect(event?.[1]).toMatchObject({ replay_id: replayId, segment_id: 0 });
    expect(raw?.[1]).toEqual({ data: recording.toString("base64") });
  });

  test("keeps Perfetto profile chunk metadata and its binary trace", () => {
    // sentry-java sends `[JSON metadata][raw .pftrace bytes]` and sets
    // `meta_length`; JSON-only chunks from other SDKs still decode as JSON.
    const metadata = Buffer.from(
      '{"chunk_id":"a1b2c3d4e5f60718293a4b5c6d7e8f90","profiler_id":"0f1e2d3c4b5a69788796a5b4c3d2e1f0","platform":"android","version":"2"}',
    );
    const trace = Buffer.from([0x0a, 0x8b, 0x01, 0x12, 0x00, 0xff, 0x10, 0x7b]);
    const chunk = Buffer.concat([metadata, trace]);
    const json = Buffer.from(
      '{"chunk_id":"cccccccccccccccccccccccccccccccc","platform":"javascript","profile":{"samples":[]}}',
    );
    const perfettoHeader = (metaLength: number) =>
      `{"type":"profile_chunk","length":${chunk.length},"content_type":"application/x-perfetto-trace","filename":"profile.pftrace","platform":"android","meta_length":${metaLength}}`;
    const body = Buffer.concat([
      Buffer.from(`{}\n${perfettoHeader(metadata.length)}\n`),
      chunk,
      Buffer.from(`\n{"type":"profile_chunk","length":${json.length}}\n`),
      json,
    ]);
    const items = createReceiverEnvelope({ body }).getParsedEnvelope()
      ?.envelope[1];
    expect(items?.[0]?.[1]).toEqual({
      chunk_id: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      profiler_id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      platform: "android",
      version: "2",
      type: "profile_chunk",
      data: trace.toString("base64"),
    });
    expect(items?.[1]?.[1]).toMatchObject({
      chunk_id: "cccccccccccccccccccccccccccccccc",
      type: "profile_chunk",
    });

    // A meta_length that does not end the JSON keeps the whole chunk raw.
    const misframed = Buffer.concat([
      Buffer.from(`{}\n${perfettoHeader(metadata.length - 1)}\n`),
      chunk,
    ]);
    expect(
      createReceiverEnvelope({ body: misframed }).getParsedEnvelope()
        ?.envelope[1][0]?.[1],
    ).toEqual({ data: chunk.toString("base64") });
  });

  test("keeps non-JSON items raw while the rest of the envelope decodes", () => {
    const event = Buffer.from(
      '{"event_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}',
    );
    // Unreal crash reports are zip archives without a content type.
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x08, 0x00]);
    // A declared non-JSON content type wins even when the bytes parse as JSON.
    const protobuf = Buffer.from("{}");
    const body = Buffer.concat([
      Buffer.from(`{}\n{"type":"event","length":${event.length}}\n`),
      event,
      Buffer.from(`\n{"type":"unreal_report","length":${zip.length}}\n`),
      zip,
      Buffer.from(
        `\n{"type":"integration","content_type":"application/x-protobuf","length":${protobuf.length}}\n`,
      ),
      protobuf,
    ]);
    const container = createReceiverEnvelope({ body });
    expect(container.getEventTypes()).toEqual([
      "event",
      "unreal_report",
      "integration",
    ]);
    expect(
      container.getParsedEnvelope()?.envelope[1].map(([, payload]) => payload),
    ).toEqual([
      { event_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", type: "event" },
      { data: zip.toString("base64") },
      { data: protobuf.toString("base64") },
    ]);
  });

  test("assigns independent stable IDs before parsing untrusted headers", () => {
    const body = Buffer.from(
      '{"__spotlight_envelope_id":"forged"}\n{"type":"event"}\n{}',
    );
    const first = createReceiverEnvelope({ body });
    const second = createReceiverEnvelope({ body });
    const firstId = prepareReceiverEnvelope(first);
    expect(firstId).toMatch(/^[a-f\d-]{36}$/);
    expect(receiverEnvelopeId(first)).toBe(firstId);
    expect(prepareReceiverEnvelope(first)).toBe(firstId);
    expect(receiverEnvelopeId(second)).not.toBe(firstId);
    expect(first.getParsedEnvelope()?.envelope[0].__spotlight_envelope_id).toBe(
      firstId,
    );
    expect(first.getData()).toBe(body);
  });
});
