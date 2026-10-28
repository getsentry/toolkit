/** HTTP/SSE compatibility facade over the shared telemetry pipeline. */
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { types } from "node:util";
import {
  createTelemetryPipeline,
  type TelemetryPayload,
  type TelemetryPipeline,
} from "@sentry/telemetry/node";
import type { IgnoreReason, IngestResult } from "@sentry/telemetry";
import { MAX_ENVELOPES } from "./retention-limits.js";

/** Parsed wire records consumed by the existing terminal and SSE formatters. */
export type LocalEnvelope = {
  envelope: [Record<string, unknown>, [{ type?: string }, unknown][]];
};
export type LocalEnvelopeContainer = {
  getParsedEnvelope(): LocalEnvelope;
  getContentType(): string;
  getData(): Buffer;
  getEventTypes(): string[];
};
type ReadFilter = { all?: true; timeWindow?: number; envelopeId?: string };
type Subscriber = {
  callback: (container: LocalEnvelopeContainer) => void;
  position: number;
  scheduled?: NodeJS.Immediate;
};
export type LocalTelemetryBuffer = {
  pipeline: TelemetryPipeline;
  ingestPayload(
    payload: TelemetryPayload,
  ): ReturnType<TelemetryPipeline["ingestPayload"]>;
  read(filters?: ReadFilter): LocalEnvelopeContainer[];
  subscribe(callback: Subscriber["callback"], lastEventId?: string): string;
  unsubscribe(id: string): void;
  stream(id: string): void;
  /** Serialize retention controls after submitted writes and before later admissions. */
  withWriteBarrier(operation: () => Promise<void>): Promise<void>;
  drain(): Promise<void>;
  clear(): void;
  reset(): void;
  dispose(): void;
};

/** Legacy SDK beacon and raw clients post envelopes as plain text. */
export function localEnvelopeContentType(value?: string): string {
  const mediaType = value?.split(";")[0]?.trim().toLowerCase();
  return !mediaType || mediaType === "text/plain"
    ? "application/x-sentry-envelope"
    : (value ?? "application/x-sentry-envelope");
}

/** Convert SDK cancellation/admission outcomes into transport retry responses. */
export function localIngestStatus(receipt: IngestResult): 204 | 400 | 503 {
  if (receipt.status === "invalid") return 400;
  if (
    receipt.status === "ignored" &&
    ["queue_full", "disposed", "reset", "aborted"].includes(receipt.reason)
  )
    return 503;
  return 204;
}

/** Keep transport cursors and arrival times here; decoding and telemetry stay in the SDK. */
export function createLocalTelemetryBuffer(
  maxEnvelopes = 500,
): LocalTelemetryBuffer {
  const maxPending = 64;
  const pipeline = createTelemetryPipeline({
    maxPending,
    retention: { maxEnvelopes },
    // Keep raw downloads available for the count retention range, within the
    // same byte budget as the parsed telemetry store.
    decodedHistory: { maxEntries: MAX_ENVELOPES, maxBytes: 64 * 1024 * 1024 },
    maxPayloadBytes: 10 * 1024 * 1024,
  });
  const entries = new Map<
    string,
    {
      container: LocalEnvelopeContainer;
      arrivedAt: number;
      position: number;
    }
  >();
  const subscribers = new Map<string, Subscriber>();
  let position = 0;
  let generation = 0;
  let disposed = false;
  let controls = 0;
  let barrier: Promise<void> = Promise.resolve();
  const writes = new Set<Promise<IngestResult>>();
  function ignored(reason: IgnoreReason): IngestResult {
    return {
      status: "ignored",
      reason,
      retained: false,
      revision: pipeline.getStats().revision,
      diagnostics: [],
      counts: {
        events: 0,
        spans: 0,
        logs: 0,
        skippedItems: 0,
        duplicateEvents: 0,
      },
    };
  }
  function reset() {
    // Clear capture data while preserving requested receiver retention configuration.
    // Pending controls remain ordered; ingress from the previous generation is cancelled.
    generation++;
    writes.clear();
    pipeline.reset();
  }
  const stream = (id: string) => {
    const subscriber = subscribers.get(id);
    if (!subscriber) return;
    for (const entry of entries.values()) {
      if (entry.position <= subscriber.position) continue;
      subscriber.position = entry.position;
      subscriber.callback(entry.container);
    }
  };
  const unsubscribePipeline = pipeline.subscribe((snapshot) => {
    const retained = new Set<string>();
    for (const envelope of snapshot.envelopes) {
      const id = String(envelope[0].__spotlight_envelope_id);
      retained.add(id);
      if (entries.has(id)) continue;
      const parsed: LocalEnvelope = {
        envelope: [
          envelope[0],
          envelope[1].map(([header, payload]) => [header, payload]),
        ],
      };
      entries.set(id, {
        arrivedAt: Date.now(),
        position: ++position,
        container: {
          getParsedEnvelope: () => parsed,
          getContentType: () => "application/x-sentry-envelope",
          getEventTypes: () =>
            parsed.envelope[1].flatMap(([header]) =>
              header.type ? [header.type] : [],
            ),
          getData: () => {
            const payload = pipeline.getDecodedPayload(id);
            if (!payload)
              throw new Error("Raw envelope is no longer retained.");
            return payload.body;
          },
        },
      });
    }
    for (const id of entries.keys()) if (!retained.has(id)) entries.delete(id);
    for (const id of subscribers.keys()) stream(id);
  });
  const unsubscribe = (id: string) => {
    const subscriber = subscribers.get(id);
    if (subscriber?.scheduled) clearImmediate(subscriber.scheduled);
    subscribers.delete(id);
  };
  return {
    pipeline,
    ingestPayload(payload) {
      if (disposed) return Promise.resolve(ignored("disposed"));
      if (writes.size >= maxPending)
        return Promise.resolve(ignored("queue_full"));
      const epoch = generation;
      // A control operation blocks new admissions until its policy check and update commit.
      // Copy deferred inputs now, matching standalone SDK ingestion semantics.
      const captured =
        controls > 0
          ? {
              ...payload,
              body: types.isUint8Array(payload.body)
                ? Buffer.from(payload.body)
                : payload.body,
            }
          : payload;
      const operation =
        controls === 0
          ? pipeline.ingestPayload(captured)
          : barrier.then(() => {
              if (disposed) return ignored("disposed");
              if (epoch !== generation) return ignored("reset");
              return pipeline.ingestPayload(captured);
            });
      writes.add(operation);
      const release = () => {
        writes.delete(operation);
      };
      void operation.then(release, release);
      return operation;
    },
    withWriteBarrier(operation) {
      const preceding = [...writes];
      controls++;
      const update = barrier.then(async () => {
        await Promise.allSettled(preceding);
        if (!disposed) await operation();
      });
      barrier = update.then(
        () => {},
        () => {},
      );
      const release = () => {
        controls--;
      };
      void update.then(release, release);
      return update;
    },
    async drain() {
      await Promise.allSettled([...writes, barrier, pipeline.drain()]);
    },
    read(filters = { timeWindow: 60 }) {
      return [...entries.entries()]
        .reverse()
        .filter(
          ([id, entry]) =>
            (filters.envelopeId === undefined || id === filters.envelopeId) &&
            (filters.timeWindow === undefined ||
              entry.arrivedAt > Date.now() - filters.timeWindow * 1000),
        )
        .map(([, entry]) => entry.container);
    },
    subscribe(callback, lastEventId) {
      const id = randomUUID();
      const subscriber: Subscriber = {
        callback,
        position: entries.get(lastEventId ?? "")?.position ?? 0,
      };
      subscribers.set(id, subscriber);
      subscriber.scheduled = setImmediate(() => stream(id));
      subscriber.scheduled.unref();
      return id;
    },
    unsubscribe,
    stream,
    clear: reset,
    reset,
    dispose() {
      disposed = true;
      generation++;
      for (const id of subscribers.keys()) unsubscribe(id);
      unsubscribePipeline();
      pipeline.dispose();
      entries.clear();
    },
  };
}
