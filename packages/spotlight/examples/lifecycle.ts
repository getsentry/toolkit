import { SDK_CAPABILITIES, type SentryEnvelope } from "@sentry/spotlight";
import { createTelemetryPipeline } from "@sentry/spotlight/node";
import { createFrontendTelemetry } from "./frontend.js";
import { inspectTrace, readEventIds } from "./reader.js";

// Parsed wire timestamps are seconds; normalized reader timestamps are Unix milliseconds.
function envelope(id: string): SentryEnvelope {
  return [
    {},
    [
      [
        { type: "span" },
        {
          version: 2,
          items: [
            {
              trace_id: "example-trace",
              span_id: id,
              name: "SELECT 1",
              start_timestamp: 1,
              end_timestamp: 1.125,
              attributes: {
                "sentry.op": { type: "string", value: "db.query" },
              },
            },
          ],
        },
      ],
    ],
  ] as const;
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const { telemetry, receiveEnvelope, disconnect } = createFrontendTelemetry();
const pipeline = createTelemetryPipeline();
try {
  const input = envelope("one");
  const first = await receiveEnvelope(input, { deliveryId: "request-1" });
  check(
    first.status === "processed" && first.retained && first.counts.spans === 1,
    "Receipt counts",
  );
  const retry = await receiveEnvelope(input, { deliveryId: "request-1" });
  check(
    retry.status === "ignored" && retry.reason === "duplicate",
    "Retained delivery retry",
  );

  // Each input gets a receipt. A malformed middle input does not roll back valid neighbors.
  const batch = await telemetry.ingestEnvelopes([
    envelope("two"),
    null,
    envelope("three"),
  ]);
  check(
    batch[0].status === "processed" &&
      batch[1].status === "invalid" &&
      batch[2].status === "processed",
    "Partial batch",
  );
  if (batch[1].status === "invalid") {
    for (const diagnostic of batch[1].diagnostics) {
      console.log(diagnostic.code, diagnostic.severity, diagnostic.itemIndex);
    }
  }
  const controller = new AbortController();
  controller.abort();
  const cancelled = await telemetry.ingestEnvelope(envelope("cancelled"), {
    signal: controller.signal,
  });
  check(
    cancelled.status === "ignored" && cancelled.reason === "aborted",
    "Cancellation receipt",
  );
  await telemetry.drain(); // A barrier for work already submitted, not future submissions.
  check(telemetry.getStats().pending === 0, "Drained work");

  const reader = inspectTrace(telemetry, "example-trace");
  check(JSON.parse(reader.snapshotJson).schemaVersion === 1, "JSON schema");
  check(
    JSON.parse(reader.profileJson).schemaVersion === 1,
    "Summary JSON schema",
  );
  const page = telemetry.readPage("events", { limit: 1 });
  check(page.status === "ok" && page.nextCursor, "Bounded page");
  await receiveEnvelope(envelope("four"));
  const stale = telemetry.readPage("events", {
    limit: 1,
    cursor: page.nextCursor,
  });
  check(
    stale.status === "invalid" && stale.code === "stale_cursor",
    "Revision-bound cursor",
  );
  check(readEventIds(telemetry).status === "ok", "Reader-only pagination");

  const wire = (id: string) =>
    `{}\n${JSON.stringify({ type: "span" })}\n${JSON.stringify(envelope(id)[1][0][1])}`;
  const payloads = await pipeline.ingestPayloads([
    { body: wire("node-one") },
    { body: "invalid" },
  ]);
  check(
    payloads[0].status === "processed" && payloads[1].status === "invalid",
    "Payload batch",
  );
  if (payloads[0].status === "processed") {
    check(
      pipeline.getDecodedPayload(payloads[0].envelopeId)?.body.length,
      "Copied decoded payload",
    );
  }
  await pipeline.drain();
  console.log(
    SDK_CAPABILITIES.timestampUnit,
    first.counts,
    telemetry.getStats(),
  );
} finally {
  pipeline.dispose();
  disconnect();
}
