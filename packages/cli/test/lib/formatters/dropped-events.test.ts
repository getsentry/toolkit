import type { ListOrganizationEventsDroppedResponse } from "@sentry/api";
import { describe, expect, test } from "vitest";
import {
  formatDroppedEvents,
  summarizeDroppedEvents,
} from "../../../src/lib/formatters/dropped-events.js";

function bucket(
  overrides: Partial<
    ListOrganizationEventsDroppedResponse["droppedEvents"][number]
  >,
): ListOrganizationEventsDroppedResponse["droppedEvents"][number] {
  return {
    type: "error",
    category: "error",
    outcome: "rate_limited",
    reason: "key_quota",
    start: 0,
    end: 1,
    count: 1,
    tags: [],
    ...overrides,
  };
}

describe("summarizeDroppedEvents", () => {
  test("collapses buckets into one row per (outcome, reason)", () => {
    const response: ListOrganizationEventsDroppedResponse = {
      meta: {
        dataset: "errors",
        start: 0,
        end: 10,
        interval: 1,
        suppressedDrops: [],
      },
      droppedEvents: [
        bucket({ reason: "key_quota", count: 3 }),
        bucket({ reason: "key_quota", count: 2 }),
        bucket({ outcome: "filtered", reason: "error_message", count: 4 }),
      ],
      acceptedEvents: [],
    };

    const rows = summarizeDroppedEvents(response);

    expect(rows).toHaveLength(2);
    const quota = rows.find((r) => r.reason === "key_quota");
    expect(quota?.events).toBe(5);
  });

  test("sorts by outcome volume, then reason volume", () => {
    const response: ListOrganizationEventsDroppedResponse = {
      meta: {
        dataset: "errors",
        start: 0,
        end: 10,
        interval: 1,
        suppressedDrops: [],
      },
      droppedEvents: [
        bucket({ outcome: "filtered", reason: "a", count: 1 }),
        bucket({ outcome: "rate_limited", reason: "b", count: 10 }),
        bucket({ outcome: "rate_limited", reason: "c", count: 5 }),
      ],
      acceptedEvents: [],
    };

    const rows = summarizeDroppedEvents(response);

    expect(rows.map((r) => r.reason)).toEqual(["b", "c", "a"]);
  });

  test("share is the slice over total dropped plus accepted", () => {
    const response: ListOrganizationEventsDroppedResponse = {
      meta: {
        dataset: "errors",
        start: 0,
        end: 10,
        interval: 1,
        suppressedDrops: [],
      },
      droppedEvents: [bucket({ count: 25 })],
      acceptedEvents: [bucket({ outcome: "accepted", count: 75 })],
    };

    const rows = summarizeDroppedEvents(response);

    expect(rows[0]!.share).toBeCloseTo(0.25);
  });

  test("defaults tags to [] when an older server omits them", () => {
    const { tags: _tags, ...untagged } = bucket({ count: 3 });
    const response = {
      meta: {
        dataset: "errors",
        start: 0,
        end: 10,
        interval: 1,
        suppressedDrops: [],
      },
      droppedEvents: [untagged],
      acceptedEvents: [],
    } as unknown as ListOrganizationEventsDroppedResponse;

    const rows = summarizeDroppedEvents(response);

    expect(rows[0]!.tags).toEqual([]);
    expect(formatDroppedEvents(rows)).toContain("—");
  });
});

describe("formatDroppedEvents", () => {
  test("returns empty string for no rows", () => {
    expect(formatDroppedEvents([])).toBe("");
  });

  test("renders one section per outcome with a reason table", () => {
    const response: ListOrganizationEventsDroppedResponse = {
      meta: {
        dataset: "errors",
        start: 0,
        end: 10,
        interval: 1,
        suppressedDrops: [],
      },
      droppedEvents: [
        bucket({ outcome: "rate_limited", reason: "key_quota", count: 5 }),
        bucket({ outcome: "filtered", reason: "error_message", count: 2 }),
      ],
      acceptedEvents: [],
    };

    const out = formatDroppedEvents(summarizeDroppedEvents(response));

    expect(out).toContain("Rate Limited");
    expect(out).toContain("Inbound Filter");
    expect(out).toContain("key_quota");
  });
});
