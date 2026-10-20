import {
  DEFAULT_MAX_ENVELOPES,
  isValidMaxEnvelopes,
} from "../../../../packages/cli/src/commands/local/retention-limits.ts";
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
  recordEnvelope: (
    envelope: LocalFeedItem,
    items?: readonly LocalFeedItem[],
  ) => void;
  setLimit: (limit: number) => void;
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
  limit = DEFAULT_MAX_ENVELOPES,
}: { limit?: number } = {}): LocalTelemetryStore {
  if (!isValidMaxEnvelopes(limit))
    throw new Error("Invalid envelope retention limit.");
  let snapshot = EMPTY_SNAPSHOT;
  const envelopeItems = new Map<string, readonly LocalFeedItem[]>();
  const listeners = new Set<() => void>();

  function publish(items: LocalFeedItem[], envelopes = snapshot.envelopes) {
    snapshot = buildSnapshot(items, envelopes);
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
      for (const id of envelopeItems.keys())
        if (!retainedIds.has(id)) envelopeItems.delete(id);
      publish(
        envelopes.flatMap((item) => [...(envelopeItems.get(item.id) ?? [])]),
        envelopes,
      );
    },
    clear() {
      envelopeItems.clear();
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
