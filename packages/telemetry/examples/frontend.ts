import { type IngestOptions, createTelemetryStore } from "@sentry/telemetry";

/** Keep one instance for the lifetime of the telemetry view. */
export function createFrontendTelemetry() {
  const telemetry = createTelemetryStore({ retention: { maxEnvelopes: 500 } });
  return {
    telemetry,
    // Pass the parsed envelopes received over SSE, WebSocket, or your own transport.
    receiveEnvelope: (envelope: unknown, options?: IngestOptions) =>
      telemetry.ingestEnvelope(envelope, options),
    disconnect: telemetry.dispose,
  };
}
