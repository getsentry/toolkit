import { describe, expect, test } from "vitest";
import type { LocalFeedItem } from "./spotlight.ts";
import { createLocalTelemetryStore } from "./telemetry-store.ts";

function item(overrides: Partial<LocalFeedItem>): LocalFeedItem {
  return {
    id: "event-1:0",
    type: "transaction",
    text: "{}",
    payload: {},
    metadata: { title: "GET /checkout" },
    ...overrides,
  };
}

describe("LocalTelemetryStore", () => {
  test("indexes a bounded session by its observability view", () => {
    const store = createLocalTelemetryStore({ limit: 3 });

    store.append([
      item({ id: "transaction:0", type: "transaction" }),
      item({
        id: "error:0",
        type: "event",
        metadata: { title: "Checkout failed", level: "error" },
      }),
      item({ id: "log:0", type: "log" }),
      item({ id: "feedback:0", type: "user_report" }),
    ]);

    const snapshot = store.getSnapshot();
    expect(snapshot.items.map((entry) => entry.id)).toEqual([
      "error:0",
      "log:0",
      "feedback:0",
    ]);
    expect(snapshot.errors.map((entry) => entry.id)).toEqual(["error:0"]);
    expect(snapshot.logs.map((entry) => entry.id)).toEqual(["log:0"]);
    expect(snapshot.feedback.map((entry) => entry.id)).toEqual(["feedback:0"]);
    expect(snapshot.traces).toEqual([]);
  });

  test("deduplicates replayed envelope items and clears derived indexes", () => {
    const store = createLocalTelemetryStore();
    const transaction = item({ id: "transaction:0", type: "transaction" });

    store.append([transaction, transaction]);
    expect(store.getSnapshot().items).toHaveLength(1);
    expect(store.getSnapshot().traces).toEqual([transaction]);

    store.clear();
    expect(store.getSnapshot()).toMatchObject({
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
    });
  });

  test("retains raw envelopes separately from decoded feed items", () => {
    const store = createLocalTelemetryStore();
    const envelope = item({
      id: "envelope-1",
      type: "envelope",
      text: "[{}, []]",
    });

    store.recordEnvelope(envelope);

    expect(store.getSnapshot().items).toEqual([]);
    expect(store.getSnapshot().envelopes).toEqual([envelope]);
  });
});
