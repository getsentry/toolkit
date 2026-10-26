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
  test("flat rows grouped by outcome then reason, sorted by volume", () => {
    const rows = summarizeDroppedEvents(RESPONSE);

    // Rows are contiguous by outcome: client_discard (100) > rate_limited (17)
    // > filtered (3); reasons sorted by volume, same-reason buckets summed.
    expect(rows.map((r) => [r.outcome, r.reason, r.events])).toEqual([
      ["client_discard", "sample_rate", 100],
      ["rate_limited", "spike_protection", 15],
      ["rate_limited", "usage_exceeded", 2],
      ["filtered", "web-crawlers", 3],
    ]);
  });

  test("every row carries the outcome's human label", () => {
    const rows = summarizeDroppedEvents(RESPONSE);
    const byOutcome = Object.fromEntries(rows.map((r) => [r.outcome, r.label]));
    expect(byOutcome.client_discard).toBe("Client Discard");
    expect(byOutcome.rate_limited).toBe("Rate Limited");
    expect(byOutcome.filtered).toBe("Inbound Filter");
  });

  test("share is a 0-1 ratio over total volume (dropped + accepted)", () => {
    const rows = summarizeDroppedEvents(RESPONSE);
    // total = 100 + 17 + 3 + 880 = 1000
    expect(rows[0].share).toBeCloseTo(0.1, 10);
  });

  test("carries the drop-classification tag onto each row", () => {
    const rows = summarizeDroppedEvents(RESPONSE);
    const byOutcome = Object.fromEntries(rows.map((r) => [r.outcome, r.tags]));
    expect(byOutcome.client_discard).toEqual(["intentional"]);
    expect(byOutcome.rate_limited).toEqual(["unintentional"]);
    expect(byOutcome.filtered).toEqual(["intentional"]);
  });

  test("empty response yields no rows", () => {
    const rows = summarizeDroppedEvents({
      meta: { dataset: "errors", start: 0, end: 0, interval: 0 },
      droppedEvents: [],
      acceptedEvents: [],
    });
    expect(rows).toEqual([]);
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
    expect(formatDroppedEvents([])).toBe("");
  });
});
