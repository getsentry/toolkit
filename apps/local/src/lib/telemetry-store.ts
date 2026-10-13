import type { LocalFeedItem } from "./spotlight.ts";
import { isAiEvent, isErrorEvent } from "./workspace.ts";

export type LocalTelemetrySnapshot = {
  items: LocalFeedItem[];
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
  append: (items: readonly LocalFeedItem[]) => void;
  recordEnvelope: (envelope: LocalFeedItem) => void;
  clear: () => void;
  getSnapshot: () => LocalTelemetrySnapshot;
  subscribe: (listener: () => void) => () => void;
};

const EMPTY_SNAPSHOT: LocalTelemetrySnapshot = {
  items: [],
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
): LocalTelemetrySnapshot {
  return {
    items,
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
    ai: items.filter(isAiEvent),
  };
}

/**
 * Session-only, bounded telemetry state shared by the Local workspace views.
 * It intentionally has no browser persistence: restarting a receiver starts a new session.
 */
export function createLocalTelemetryStore({
  limit = 500,
}: { limit?: number } = {}): LocalTelemetryStore {
  let snapshot = EMPTY_SNAPSHOT;
  const listeners = new Set<() => void>();

  function publish(items: LocalFeedItem[], envelopes = snapshot.envelopes) {
    snapshot = buildSnapshot(items, envelopes);
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    append(incoming) {
      if (incoming.length === 0) {
        return;
      }

      const knownIds = new Set(snapshot.items.map((item) => item.id));
      const newItems = incoming.filter((item) => {
        if (knownIds.has(item.id)) {
          return false;
        }
        knownIds.add(item.id);
        return true;
      });
      if (newItems.length === 0) {
        return;
      }

      publish([...snapshot.items, ...newItems].slice(-limit));
    },
    recordEnvelope(envelope) {
      if (snapshot.envelopes.some((item) => item.id === envelope.id)) {
        return;
      }
      publish(snapshot.items, [...snapshot.envelopes, envelope].slice(-limit));
    },
    clear() {
      if (snapshot.items.length > 0 || snapshot.envelopes.length > 0) {
        publish([], []);
      }
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
