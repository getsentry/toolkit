import {
  type IngestResult,
  type ProcessedEvent,
  type QuerySummary,
  SDK_CAPABILITIES,
  type TelemetryReader,
  createTelemetryReader,
  createTelemetryStore,
  serializeSnapshot,
  serializeSummaries,
  serializeTrace,
} from "@sentry/telemetry";

const telemetry = createTelemetryStore();
const queries: readonly QuerySummary[] = telemetry.getDatabaseQuerySummaries({
  traceId: "trace",
  includeSpans: true,
});
const events: readonly ProcessedEvent[] = telemetry.getEvents({
  traceId: "trace",
  spanId: "span",
});
const envelope = telemetry.getEnvelope("envelope");
if (envelope) {
  const [header, items] = envelope;
  const sdk = header.sdk;
  for (const [itemHeader, payload] of items) {
    const type: string = itemHeader.type;
    void type;
    void payload;
  }
  void sdk;
}
// @ts-expect-error State storage is private.
void telemetry.store;
// @ts-expect-error Public events are read-only.
events.push(events[0]);
// @ts-expect-error Nested maps cannot be mutated through the public type.
telemetry.getTrace("trace")?.spans.clear();
// @ts-expect-error Duration units are explicit in the public contract.
void queries[0].totalTime;
const normalizedTimestamp: number = events[0].timestamp;
void normalizedTimestamp;
void queries[0].totalDurationMs;
void queries[0].averageDurationMs;

const reader: TelemetryReader = createTelemetryReader(() =>
  telemetry.getSnapshot(),
);
// @ts-expect-error Read-only consumers cannot ingest.
void reader.ingestEnvelope;
const compact = reader.getDatabaseQuerySummaries();
// @ts-expect-error Full spans require includeSpans: true.
const full: readonly QuerySummary[] = compact;
void full;
const page = reader.readPage("events", {
  fromMs: 0,
  toMs: 10000,
  order: "desc",
  limit: 20,
});
if (page.status === "ok") {
  const events: readonly ProcessedEvent[] = page.items;
  void events;
  const cursor: string | undefined = page.nextCursor;
  void cursor;
} else {
  const code: "stale_cursor" | "invalid_cursor" | "invalid_query" = page.code;
  void code;
}
const snapshot = serializeSnapshot(reader.getSnapshot());
const version: 1 = snapshot.schemaVersion;
const unit: "unix-milliseconds" = SDK_CAPABILITIES.timestampUnit;
const trace = reader.getTrace("trace");
if (trace) JSON.stringify(serializeTrace(trace));
JSON.stringify(snapshot);
JSON.stringify(serializeSummaries(compact));
JSON.stringify(serializeSummaries(reader.getProfileFunctionSummaries()));
// @ts-expect-error Export full span graphs through serializeTrace instead.
serializeSummaries(queries);
void version;
void unit;
async function receipts() {
  const results: readonly IngestResult[] = await telemetry.ingestEnvelopes(
    [null],
    {
      signal: new AbortController().signal,
    },
  );
  const receipt = await telemetry.ingestEnvelope(null, { deliveryId: "retry" });
  const retained: boolean = receipt.retained;
  const revision: number = receipt.revision;
  const duplicates: number = receipt.counts.duplicateEvents;
  // @ts-expect-error Receipts are immutable.
  receipt.counts.events = 0;
  if (receipt.status === "ignored") {
    // @ts-expect-error Reasons are a literal union.
    const reason: "arbitrary-text" = receipt.reason;
    void reason;
  }
  if (receipt.status === "invalid") {
    const severity: "warning" | "error" = receipt.diagnostics[0].severity;
    const index: number | undefined = receipt.diagnostics[0].itemIndex;
    void severity;
    void index;
  }
  const resized: Promise<void> = telemetry.setRetention({ maxEnvelopes: 10 });
  await resized;
  await telemetry.drain();
  void results;
  void retained;
  void revision;
  void duplicates;
}
void receipts;
telemetry.dispose();
