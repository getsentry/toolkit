// @vitest-environment node
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { createTelemetryStore, type Diagnostic } from "./core.ts";
import { createTelemetryPipeline } from "./node.ts";

const malformedSpans = [
  { name: "legacy span", payload: {}, skipped: 1 },
  { name: "v2 span", payload: { version: 2, items: [{}] }, skipped: 1 },
  {
    name: "v2 entries with missing IDs and invalid timestamps",
    payload: {
      version: 2,
      items: [
        null,
        { trace_id: "trace", span_id: "missing-time" },
        {
          trace_id: "trace",
          span_id: "bad-time",
          start_timestamp: "1",
          end_timestamp: 2,
        },
      ],
    },
    skipped: 3,
  },
];

test.each(malformedSpans)(
  "core retains a malformed-only $name envelope without inventing telemetry",
  async ({ payload, skipped }) => {
    const diagnostics: Diagnostic[] = [];
    const telemetry = createTelemetryStore({
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    try {
      const envelope = [{}, [[{ type: "span" }, payload]]];
      const initialRevision = telemetry.getStats().revision;
      const receipt = await telemetry.ingestEnvelope(envelope, {
        deliveryId: "malformed-only",
      });
      expect(receipt).toMatchObject({
        status: "processed",
        envelopeId: "malformed-only",
        retained: true,
        revision: initialRevision + 1,
        counts: {
          events: 0,
          spans: 0,
          logs: 0,
          skippedItems: skipped,
          duplicateEvents: 0,
        },
        diagnostics: [
          { code: "invalid_span", severity: "warning", itemIndex: 0 },
        ],
      });
      expect(diagnostics).toEqual(receipt.diagnostics);
      expect(telemetry.getEnvelope("malformed-only")?.[1]).toEqual(envelope[1]);
      expect(telemetry.getEvents()).toEqual([]);
      expect(telemetry.getTraces()).toEqual([]);
      expect(telemetry.getSpans()).toEqual([]);
      expect(telemetry.getLogs()).toEqual([]);

      const snapshot = telemetry.getSnapshot();
      expect(
        await telemetry.ingestEnvelope(envelope, {
          deliveryId: "malformed-only",
        }),
      ).toMatchObject({
        status: "ignored",
        reason: "duplicate",
        retained: true,
      });
      expect(telemetry.getSnapshot()).toBe(snapshot);
    } finally {
      telemetry.dispose();
    }
  },
);

test("malformed-only envelopes follow normal retention and permit delivery retries after eviction", async () => {
  const telemetry = createTelemetryStore({ retention: { maxEnvelopes: 1 } });
  const malformed = [{}, [[{ type: "span" }, { version: 2, items: [{}] }]]];
  try {
    await telemetry.ingestEnvelope(malformed, { deliveryId: "malformed" });
    await telemetry.ingestEnvelope(
      [{}, [[{ type: "event" }, { event_id: "next" }]]],
      {
        deliveryId: "next",
      },
    );
    expect(telemetry.getEnvelope("malformed")).toBeUndefined();
    expect(
      await telemetry.ingestEnvelope(malformed, { deliveryId: "malformed" }),
    ).toMatchObject({ status: "processed", retained: true });
    expect(telemetry.getEnvelopes()).toHaveLength(1);
    expect(telemetry.getEvents()).toEqual([]);
  } finally {
    telemetry.dispose();
  }
});

test.each([undefined, "gzip"] as const)(
  "Node retains malformed-only decoded bytes and publishes them with the envelope (%s)",
  async (encoding) => {
    const telemetry = createTelemetryPipeline();
    const body = Buffer.from('{}\n{"type":"span"}\n{"version":2,"items":[{}]}');
    const observed: unknown[] = [];
    telemetry.subscribe(() => {
      observed.push(telemetry.getDecodedPayload("malformed-wire")?.body);
    });
    try {
      const receipt = await telemetry.ingestPayload({
        body: encoding ? gzipSync(body) : body,
        encoding,
        deliveryId: "malformed-wire",
      });
      expect(receipt).toMatchObject({
        status: "processed",
        retained: true,
        envelopeId: "malformed-wire",
        diagnostics: [
          { code: "invalid_span", severity: "warning", itemIndex: 0 },
        ],
        counts: {
          events: 0,
          spans: 0,
          logs: 0,
          skippedItems: 1,
          duplicateEvents: 0,
        },
      });
      expect(observed).toEqual([body]);
      expect(telemetry.getEnvelope("malformed-wire")?.[1][0][1]).toMatchObject({
        version: 2,
        items: [{}],
      });
      expect(telemetry.getDecodedPayload("malformed-wire")?.body).toEqual(body);
      expect(telemetry.getTraces()).toEqual([]);
      expect(telemetry.getEvents()).toEqual([]);
    } finally {
      telemetry.dispose();
    }
  },
);

test("retaining malformed spans preserves valid neighbors and their receipt counts", async () => {
  const telemetry = createTelemetryStore();
  try {
    const receipt = await telemetry.ingestEnvelope([
      {},
      [
        [{ type: "span" }, { version: 2, items: [{}] }],
        [{ type: "event" }, { event_id: "valid-neighbor", message: "kept" }],
      ],
    ]);
    expect(receipt).toMatchObject({
      status: "processed",
      retained: true,
      diagnostics: [
        { code: "invalid_span", severity: "warning", itemIndex: 0 },
      ],
      counts: {
        events: 1,
        spans: 0,
        logs: 0,
        skippedItems: 1,
        duplicateEvents: 0,
      },
    });
    expect(telemetry.getEvent("valid-neighbor")?.message).toBe("kept");
    expect(telemetry.getTraces()).toEqual([]);
  } finally {
    telemetry.dispose();
  }
});

test("malformed span retention still rejects invalid envelope structure and serialized JSON", async () => {
  const telemetry = createTelemetryPipeline();
  try {
    expect(
      await telemetry.ingestEnvelope([{}, [[{ type: "span" }, null]]]),
    ).toMatchObject({
      status: "invalid",
      retained: false,
      diagnostics: [{ code: "invalid_envelope" }],
    });
    expect(
      await telemetry.ingestPayload({
        body: '{}\n{"type":"span"}\n{"items":',
        deliveryId: "invalid-json",
      }),
    ).toMatchObject({
      status: "invalid",
      retained: false,
      diagnostics: [{ code: "invalid_envelope" }],
    });
    expect(
      await telemetry.ingestPayload({
        body: "{}",
        contentType: "application/json",
      }),
    ).toMatchObject({
      status: "ignored",
      reason: "unsupported_content_type",
      retained: false,
    });
    expect(telemetry.getEnvelopes()).toEqual([]);
    expect(telemetry.getDecodedPayload("invalid-json")).toBeUndefined();
  } finally {
    telemetry.dispose();
  }
});
