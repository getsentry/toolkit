import { describe, expect, test } from "vitest";
import { createReceiverEnvelope } from "../../../src/commands/local/envelope.js";
import {
  prepareReceiverEnvelope,
  receiverEnvelopeId,
} from "../../../src/commands/local/receiver-ingest.js";

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
