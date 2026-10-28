import type { Envelope } from "@sentry/core";
import { describe, expect, test, vi } from "vitest";
import { normalizeEnvelope } from "../internal/envelopes.ts";
import { decodeEnvelope } from "./codec.ts";

const encode = (value: string) => new TextEncoder().encode(value);

describe("portable byte envelope codec", () => {
  test("parses Uint8Array text attachment bytes with explicit byte lengths", () => {
    const text = "é\nhello";
    const payload = encode(text);
    const header = encode(
      `{}\n${JSON.stringify({ type: "attachment", content_type: "text/plain", length: payload.length })}\n`,
    );
    const bytes = new Uint8Array(header.length + payload.length);
    bytes.set(header);
    bytes.set(payload, header.length);
    const envelope = decodeEnvelope(bytes, undefined, undefined, true)!;
    expect(envelope[1][0][1]).toEqual({ data: text });
    expect(envelope[0].__spotlight_inferred_source).toBe("server");
  });

  test("uses the same text and binary policies for parsed and wire envelopes", () => {
    for (const content_type of [
      "text/plain",
      "application/json",
      "application/octet-stream",
      undefined,
    ]) {
      const payload = encode("\ufeffhéllo");
      const itemHeader = {
        type: "attachment",
        content_type,
        length: payload.length,
      };
      const wireHeader = encode(`{}\n${JSON.stringify(itemHeader)}\n`);
      const wire = new Uint8Array(wireHeader.length + payload.length);
      wire.set(wireHeader);
      wire.set(payload, wireHeader.length);
      const decoded = decodeEnvelope(wire, undefined, undefined, true)!;
      const parsed = normalizeEnvelope([
        {},
        [[itemHeader, payload]],
      ] as Envelope);
      expect(decoded[1]).toEqual(parsed[1]);
    }
  });

  test("retains the legacy statsd default text policy", () => {
    const wire = decodeEnvelope(
      encode('{}\n{"type":"statsd"}\ncount:1|c'),
      undefined,
      undefined,
      true,
    )!;
    const parsed = normalizeEnvelope([
      {},
      [[{ type: "statsd" }, "count:1|c"]],
    ] as unknown as Envelope);
    expect(wire[1]).toEqual(parsed[1]);
    expect(wire[1][0][1]).toEqual({ data: "count:1|c" });
  });

  test("preserves permissive truncation handling while strict decoding rejects it", () => {
    const bytes = encode('{}\n{"type":"attachment","length":30}\nshort');
    const errors = vi.fn();
    expect(decodeEnvelope(bytes, undefined, errors)).not.toBeNull();
    expect(errors).not.toHaveBeenCalled();
    expect(decodeEnvelope(bytes, undefined, errors, true)).toBeNull();
    expect(errors).toHaveBeenCalledOnce();
  });

  test.each([-1, -100, 1.5, "1", null, false])(
    "rejects invalid item length %j in both decoder modes",
    (length) => {
      const bytes = encode(
        `{}\n${JSON.stringify({ type: "attachment", length })}\n`,
      );
      for (const strict of [false, true]) {
        const errors = vi.fn();
        expect(decodeEnvelope(bytes, undefined, errors, strict)).toBeNull();
        expect(errors).toHaveBeenCalledOnce();
      }
    },
  );

  test.each([
    [
      "sentry.javascript.nextjs",
      "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36",
      "browser",
    ],
    ["sentry.cocoa", "Mozilla/5.0 Safari/605", "mobile"],
    ["sentry.javascript.node", "Node.js/24", "server"],
  ])("preserves source inference for %s", (name, userAgent, source) => {
    const envelope = decodeEnvelope(
      encode(`${JSON.stringify({ sdk: { name, version: "1" } })}\n`),
      userAgent,
    )!;
    expect(envelope[0].__spotlight_sender_user_agent).toBe(userAgent);
    expect(envelope[0].__spotlight_inferred_source).toBe(source);
  });
});
