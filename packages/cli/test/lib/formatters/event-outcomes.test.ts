import type { ListOrganizationEventsDroppedResponse } from "@sentry/api";
import { describe, expect, test } from "vitest";
import {
  formatEventOutcomes,
  summarizeEventOutcomes,
} from "../../../src/lib/formatters/event-outcomes.js";

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

function accepted(
  count: number,
): ListOrganizationEventsDroppedResponse["acceptedEvents"][number] {
  return bucket({ outcome: "accepted", reason: "accepted", count, tags: [] });
}

describe("summarizeEventOutcomes", () => {
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

    const rows = summarizeEventOutcomes(response);

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

    const rows = summarizeEventOutcomes(response);

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
      acceptedEvents: [accepted(75)],
    };

    const rows = summarizeEventOutcomes(response);

    expect(rows.map((r) => [r.outcome, r.share])).toEqual([
      ["accepted", 0.75],
      ["rate_limited", 0.25],
    ]);
  });

  test("lists accepted volume first, even when drops outnumber it", () => {
    const response: ListOrganizationEventsDroppedResponse = {
      meta: {
        dataset: "errors",
        start: 0,
        end: 10,
        interval: 1,
        suppressedDrops: [],
      },
      droppedEvents: [bucket({ count: 90 })],
      acceptedEvents: [accepted(4), accepted(6)],
    };

    const rows = summarizeEventOutcomes(response);

    expect(rows[0]).toMatchObject({
      outcome: "accepted",
      label: "Accepted",
      events: 10,
      tags: [],
    });
    expect(rows[1]!.outcome).toBe("rate_limited");
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

    const rows = summarizeEventOutcomes(response);

    expect(rows[0]!.tags).toEqual([]);
    expect(formatEventOutcomes(rows)).toContain("—");
  });
});

describe("formatEventOutcomes", () => {
  test("returns empty string for no rows", () => {
    expect(formatEventOutcomes([])).toBe("");
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

    const out = formatEventOutcomes(summarizeEventOutcomes(response));

    expect(out).toContain("Rate Limited");
    expect(out).toContain("Inbound Filter");
    expect(out).toContain("key_quota");
  });

  test("renders accepted volume as a header line without a table", () => {
    const response: ListOrganizationEventsDroppedResponse = {
      meta: {
        dataset: "errors",
        start: 0,
        end: 10,
        interval: 1,
        suppressedDrops: [],
      },
      droppedEvents: [bucket({ reason: "key_quota", count: 1 })],
      acceptedEvents: [accepted(3)],
    };

    const out = formatEventOutcomes(summarizeEventOutcomes(response));
    const [acceptedSection, droppedSection] = out.split("\n\n");

    expect(acceptedSection).toContain("Accepted: 3 (75.00%)");
    expect(acceptedSection).not.toContain("Reason");
    expect(droppedSection).toContain("Rate Limited: 1 dropped (25.00%)");
  });
});
