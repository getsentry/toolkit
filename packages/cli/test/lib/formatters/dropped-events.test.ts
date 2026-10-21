import { describe, expect, test } from "vitest";
import {
  formatDroppedEvents,
  summarizeDroppedEvents,
} from "../../../src/lib/formatters/dropped-events.js";
import type { DroppedEventsResponse } from "../../../src/types/dropped-events.js";

function bucket(
  overrides: Partial<DroppedEventsResponse["droppedEvents"][number]>,
): DroppedEventsResponse["droppedEvents"][number] {
  return {
    type: "error",
    category: "error",
    outcome: "rate_limited",
    reason: "spike_protection",
    start: 0,
    end: 3600,
    count: 1,
    tags: ["unintentional"],
    ...overrides,
  };
}

const RESPONSE: DroppedEventsResponse = {
  meta: { dataset: "errors", start: 0, end: 7200, interval: 3600000 },
  droppedEvents: [
    bucket({
      outcome: "client_discard",
      reason: "sample_rate",
      count: 100,
      tags: ["intentional"],
    }),
    bucket({ outcome: "rate_limited", reason: "spike_protection", count: 10 }),
    bucket({ outcome: "rate_limited", reason: "spike_protection", count: 5 }),
    bucket({ outcome: "rate_limited", reason: "usage_exceeded", count: 2 }),
    bucket({
      outcome: "filtered",
      reason: "web-crawlers",
      count: 3,
      tags: ["intentional"],
    }),
  ],
  acceptedEvents: [
    bucket({ outcome: "accepted", reason: "accepted", count: 880, tags: [] }),
  ],
};

describe("summarizeDroppedEvents", () => {
  test("groups by outcome then reason, sorted by volume", () => {
    const { outcomes } = summarizeDroppedEvents(RESPONSE);

    // client_discard (100) > rate_limited (17) > filtered (3)
    expect(outcomes.map((o) => o.outcome)).toEqual([
      "client_discard",
      "rate_limited",
      "filtered",
    ]);

    const rateLimited = outcomes[1];
    expect(rateLimited.events).toBe(17);
    // reasons sorted by volume, and same-reason buckets summed
    expect(rateLimited.reasons.map((r) => [r.reason, r.events])).toEqual([
      ["spike_protection", 15],
      ["usage_exceeded", 2],
    ]);
  });

  test("share is a 0-1 ratio over total volume (dropped + accepted)", () => {
    const { outcomes } = summarizeDroppedEvents(RESPONSE);
    // total = 100 + 17 + 3 + 880 = 1000
    const clientDiscard = outcomes[0];
    expect(clientDiscard.share).toBeCloseTo(0.1, 10);
    expect(clientDiscard.reasons[0].share).toBeCloseTo(0.1, 10);
  });

  test("carries the drop-classification tag onto each reason", () => {
    const { outcomes } = summarizeDroppedEvents(RESPONSE);
    const byOutcome = Object.fromEntries(outcomes.map((o) => [o.outcome, o]));
    expect(byOutcome.client_discard.reasons[0].tags).toEqual(["intentional"]);
    expect(byOutcome.rate_limited.reasons[0].tags).toEqual(["unintentional"]);
    expect(byOutcome.filtered.reasons[0].tags).toEqual(["intentional"]);
  });

  test("empty response yields no outcomes", () => {
    const { outcomes } = summarizeDroppedEvents({
      meta: { dataset: "errors", start: 0, end: 0, interval: 0 },
      droppedEvents: [],
      acceptedEvents: [],
    });
    expect(outcomes).toEqual([]);
  });
});

describe("formatDroppedEvents", () => {
  test("renders a section per outcome with a Tags column", () => {
    const text = formatDroppedEvents(summarizeDroppedEvents(RESPONSE));
    expect(text).toContain("Client Discard");
    expect(text).toContain("Rate Limited");
    expect(text).toContain("Tags");
    expect(text).toContain("intentional");
    expect(text).toContain("unintentional");
    expect(text).toContain("sample_rate");
  });

  test("empty result renders nothing", () => {
    expect(formatDroppedEvents({ outcomes: [] })).toBe("");
  });
});
