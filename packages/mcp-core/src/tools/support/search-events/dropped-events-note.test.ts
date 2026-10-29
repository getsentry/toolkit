import { describe, expect, it } from "vitest";
import type { SentryApiService } from "../../../api-client";
import { buildDroppedEventsNote } from "./dropped-events-note";

function bucket(
  over: Partial<{
    outcome: string;
    reason: string;
    start: number;
    count: number;
    tags: string[];
  }>,
) {
  return {
    type: "system",
    category: "span",
    outcome: "rate_limited",
    reason: "key_quota",
    start: 1_700_000_000_000,
    end: 1_700_003_600_000,
    count: 0,
    tags: [] as string[],
    ...over,
  };
}

function stubApi(
  response: unknown,
  opts: { throws?: boolean } = {},
): SentryApiService {
  return {
    getDroppedEvents: async () => {
      if (opts.throws) {
        throw new Error("boom");
      }
      return response;
    },
  } as unknown as SentryApiService;
}

const base = {
  organizationSlug: "org",
  projectId: "1",
  dataset: "errors" as const,
  interval: "1h" as string | null,
  timeParams: { statsPeriod: "24h" },
  toolAvailable: true,
};

describe("buildDroppedEventsNote", () => {
  it("emits a note when unintentional drops are material", async () => {
    const apiService = stubApi({
      meta: { dataset: "errors", start: 0, end: 0, interval: 3_600_000 },
      droppedEvents: [bucket({ count: 400, tags: ["unintentional"] })],
      acceptedEvents: [bucket({ outcome: "accepted", count: 600 })],
    });
    const note = await buildDroppedEventsNote({ ...base, apiService });
    // 400 / (400 + 600) = 40% >> 5% threshold
    expect(note).toContain("## Dropped Events");
    expect(note).toContain("40.0%");
    expect(note).toContain("find_dropped_events");
  });

  it("stays silent below the materiality threshold", async () => {
    const apiService = stubApi({
      meta: { dataset: "errors", start: 0, end: 0, interval: 3_600_000 },
      droppedEvents: [bucket({ count: 10, tags: ["unintentional"] })],
      acceptedEvents: [bucket({ outcome: "accepted", count: 10_000 })],
    });
    // 10 / 10_010 ≈ 0.1% < 5%
    expect(await buildDroppedEventsNote({ ...base, apiService })).toBe("");
  });

  it("ignores intentional drops", async () => {
    const apiService = stubApi({
      meta: { dataset: "errors", start: 0, end: 0, interval: 3_600_000 },
      droppedEvents: [bucket({ count: 5000, tags: ["intentional"] })],
      acceptedEvents: [bucket({ outcome: "accepted", count: 100 })],
    });
    // Huge drop share, but all intentional (sampling/filters) → nothing to say.
    expect(await buildDroppedEventsNote({ ...base, apiService })).toBe("");
  });

  it("omits the tool hint when the tool is unavailable", async () => {
    const apiService = stubApi({
      meta: { dataset: "errors", start: 0, end: 0, interval: 3_600_000 },
      droppedEvents: [bucket({ count: 400, tags: ["unintentional"] })],
      acceptedEvents: [bucket({ outcome: "accepted", count: 600 })],
    });
    const note = await buildDroppedEventsNote({
      ...base,
      apiService,
      toolAvailable: false,
    });
    expect(note).toContain("## Dropped Events");
    expect(note).not.toContain("find_dropped_events");
  });

  it("returns empty for datasets the endpoint does not cover", async () => {
    const apiService = stubApi({});
    expect(
      await buildDroppedEventsNote({
        ...base,
        apiService,
        dataset: "profiles" as never,
      }),
    ).toBe("");
  });

  it("never throws into the search path when the fetch fails", async () => {
    const apiService = stubApi({}, { throws: true });
    expect(await buildDroppedEventsNote({ ...base, apiService })).toBe("");
  });
});
