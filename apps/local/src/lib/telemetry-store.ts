import { createTelemetryStore } from "@sentry/spotlight";
import { adaptTraceGroups, type TraceGroup } from "./trace-model.ts";
import { aiItems } from "./inspection.ts";
import {
  DEFAULT_MAX_ENVELOPES,
  isValidMaxEnvelopes,
} from "../../../../packages/cli/src/commands/local/retention-limits.ts";
import type { LocalFeedItem } from "./spotlight.ts";
import { isErrorEvent } from "./workspace.ts";

export type LocalTelemetrySnapshot = {
  items: LocalFeedItem[];
  traceGroups: TraceGroup[];
  errors: LocalFeedItem[];
  traces: LocalFeedItem[];
  logs: LocalFeedItem[];
  feedback: LocalFeedItem[];
  envelopes: LocalFeedItem[];
  attachments: LocalFeedItem[];
  profiles: LocalFeedItem[];
  sdks: LocalFeedItem[];
  ai: LocalFeedItem[];
};

export type LocalTelemetryStore = {
  recordEnvelope: (
    envelope: LocalFeedItem,
    items?: readonly LocalFeedItem[],
  ) => void;
  setLimit: (limit: number) => void;
  clear: () => void;
  drain: () => Promise<void>;
  getSnapshot: () => LocalTelemetrySnapshot;
  subscribe: (listener: () => void) => () => void;
};

const EMPTY_SNAPSHOT: LocalTelemetrySnapshot = {
  items: [],
  traceGroups: [],
  errors: [],
  traces: [],
  logs: [],
  feedback: [],
  envelopes: [],
  attachments: [],
  profiles: [],
  sdks: [],
  ai: [],
};

function buildSnapshot(
  items: LocalFeedItem[],
  envelopes: LocalFeedItem[],
  traceGroups: TraceGroup[] = [],
): LocalTelemetrySnapshot {
  return {
    items,
    traceGroups,
    errors: items.filter(isErrorEvent),
    traces: items.filter(
      (item) => item.type === "transaction" || item.type === "span",
    ),
    logs: items.filter((item) => item.type === "log"),
    feedback: items.filter(
      (item) => item.type === "user_report" || item.type === "feedback",
    ),
    envelopes,
    attachments: items.filter((item) => item.type === "attachment"),
    profiles: items.filter(
      (item) => item.type === "profile" || item.type === "profile_chunk",
    ),
    sdks: items.filter(
      (item) => item.type === "client_report" || item.type === "session",
    ),
    ai: aiItems(items),
  };
}

/**
 * Session-only, bounded telemetry state shared by the Local workspace views.
 * It intentionally has no browser persistence: restarting a receiver starts a new session.
 */
export function createLocalTelemetryStore({
  limit = DEFAULT_MAX_ENVELOPES,
}: { limit?: number } = {}): LocalTelemetryStore {
  if (!isValidMaxEnvelopes(limit))
    throw new Error("Invalid envelope retention limit.");
  let snapshot = EMPTY_SNAPSHOT;
  const envelopeItems = new Map<string, readonly LocalFeedItem[]>();
  const listeners = new Set<() => void>();
  // The raw capture is synchronous. Shared processing is serialized so bursts
  // cannot overflow the SDK queue, and reset invalidates work from older captures.
  let processor = createProcessor();
  let processing = Promise.resolve();
  let generation = 0;
  let processorLimit = limit;
  let needsRebuild = false;
  let scheduled = false;
  let dirty = false;
  const processedRawIds = new Set<string>();
  function createProcessor() {
    return createTelemetryStore({
      retention: { maxEnvelopes: limit, maxBytes: Number.MAX_SAFE_INTEGER },
      maxEnvelopeBytes: Number.MAX_SAFE_INTEGER,
    });
  }
  function parsedEnvelope(envelope: LocalFeedItem): unknown {
    try {
      return JSON.parse(envelope.text);
    } catch {
      return undefined;
    }
  }
  function updateProcessed() {
    dirty = true;
    if (scheduled) return;
    scheduled = true;
    const epoch = generation;
    processing = Promise.resolve().then(async () => {
      try {
        // Coalesce a burst into the latest retained capture instead of retaining
        // an unbounded promise chain or an envelope-list copy per delivery.
        while (dirty && epoch === generation) {
          dirty = false;
          const retained = snapshot.envelopes;
          const retainedIds = new Set(retained.map((raw) => raw.id));
          if (
            needsRebuild ||
            [...processedRawIds].some((id) => !retainedIds.has(id))
          ) {
            processor.reset();
            processedRawIds.clear();
            needsRebuild = false;
          }
          if (processorLimit !== limit) {
            const nextLimit = limit;
            await processor.setRetention({ maxEnvelopes: nextLimit });
            if (epoch !== generation) return;
            processorLimit = nextLimit;
          }
          for (const raw of retained) {
            if (epoch !== generation) return;
            if (processedRawIds.has(raw.id)) continue;
            await processor.ingestEnvelope(parsedEnvelope(raw), {
              deliveryId: raw.id,
            });
            if (epoch !== generation) return;
            processedRawIds.add(raw.id);
          }
          if (epoch !== generation) return;
          // A capture can change while ingestion yields. Rebuild against the
          // latest retention window before publishing any of that work.
          if (dirty) continue;
          publish(
            snapshot.items,
            snapshot.envelopes,
            adaptTraceGroups(snapshot.items, processor.getTraces()),
          );
        }
      } catch {
        // A malformed capture must not poison later deliveries. Keep its raw data
        // inspectable and rebuild derived state on the next successful operation.
        if (epoch === generation) needsRebuild = true;
      } finally {
        if (epoch === generation) scheduled = false;
      }
    });
  }

  function publish(
    items: LocalFeedItem[],
    envelopes = snapshot.envelopes,
    traceGroups = snapshot.traceGroups,
  ) {
    snapshot = buildSnapshot(items, envelopes, traceGroups);
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    setLimit(value) {
      if (!isValidMaxEnvelopes(value))
        throw new Error("Invalid envelope retention limit.");
      limit = value;
    },
    recordEnvelope(envelope, decoded = []) {
      if (snapshot.envelopes.some((item) => item.id === envelope.id)) {
        return;
      }
      envelopeItems.set(envelope.id, decoded);
      const envelopes = [...snapshot.envelopes, envelope].slice(-limit);
      const retainedIds = new Set(envelopes.map((item) => item.id));
      for (const id of envelopeItems.keys()) {
        if (!retainedIds.has(id)) {
          envelopeItems.delete(id);
          needsRebuild = true;
        }
      }
      const items = envelopes.flatMap((item) => [
        ...(envelopeItems.get(item.id) ?? []),
      ]);
      publish(
        items,
        envelopes,
        // The shared processor still contains the previous retention window
        // until its asynchronous rebuild. Never expose those evicted spans.
        adaptTraceGroups(items, needsRebuild ? [] : processor.getTraces()),
      );
      updateProcessed();
    },
    drain: () => processing,
    clear() {
      generation++;
      processor.reset();
      processing = Promise.resolve();
      dirty = false;
      scheduled = false;
      needsRebuild = false;
      processedRawIds.clear();
      envelopeItems.clear();
      if (snapshot.items.length > 0 || snapshot.envelopes.length > 0) {
        publish([], [], []);
      }
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
