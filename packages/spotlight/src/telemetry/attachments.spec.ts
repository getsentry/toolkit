import { describe, expect, test } from "vitest";
import { createTelemetryStore } from "../sdk/core.ts";

describe("parsed protocol attachments", () => {
  test.each([
    [
      "binary bytes",
      new Uint8Array([0, 10, 255]),
      "application/octet-stream",
      "AAr/",
    ],
    ["binary string", "héllo", "application/octet-stream", "aMOpbGxv"],
    [
      "text bytes",
      new TextEncoder().encode("héllo\n世界"),
      "text/plain",
      "héllo\n世界",
    ],
    ["text string", "héllo\n世界", "text/plain", "héllo\n世界"],
    [
      "text with byte order mark",
      new Uint8Array([239, 187, 191, 65]),
      "text/plain",
      "\uFEFFA",
    ],
  ] as const)(
    "associates %s with its event and retains canonical immutable data",
    async (_, payload, contentType, data) => {
      const telemetry = createTelemetryStore();
      const input = [
        {},
        [
          [
            { type: "event" },
            { event_id: "attached-event", message: "hello", timestamp: 1 },
          ],
          [
            { type: "attachment", filename: "file", content_type: contentType },
            payload,
          ],
        ],
      ];
      const original = structuredClone(input);
      const result = await telemetry.ingestEnvelope(input);
      expect(result.status).toBe("processed");
      expect(telemetry.getEvent("attached-event")?.attachments).toMatchObject([
        { data },
      ]);
      expect(telemetry.getEnvelopes()[0][1][1][1]).toEqual({ data });
      expect(Object.isFrozen(telemetry.getEnvelopes()[0][1][1][1])).toBe(true);
      expect(input).toEqual(original);
      telemetry.dispose();
    },
  );

  test("retains opaque unsupported items without discarding their accompanying event", async () => {
    const telemetry = createTelemetryStore();
    const result = await telemetry.ingestEnvelope([
      {},
      [
        [{ type: "event" }, { event_id: "event", timestamp: 1 }],
        [{ type: "future_binary" }, new Uint8Array([0, 255])],
        [{ type: "future_text" }, "hello"],
      ],
    ]);
    expect(result.status).toBe("processed");
    expect(telemetry.getEvent("event")).toBeDefined();
    expect(
      telemetry
        .getEnvelopes()[0][1]
        .slice(1)
        .map((item) => item[1]),
    ).toEqual([{ data: "AP8=" }, { data: "aGVsbG8=" }]);
    telemetry.dispose();
  });

  test("continues to reject primitive payloads for supported telemetry items", async () => {
    const telemetry = createTelemetryStore();
    const result = await telemetry.ingestEnvelope([
      {},
      [[{ type: "event" }, "not a parsed event"]],
    ]);
    expect(result.status).toBe("invalid");
    expect(telemetry.getEnvelopes()).toEqual([]);
    telemetry.dispose();
  });
});
