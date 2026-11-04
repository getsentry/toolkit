import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import findDroppedEvents, {
  findDroppedEventsOutputSchema,
  resolveDroppedEventsInterval,
} from "./find-dropped-events.js";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

const DROPPED_EVENTS_RESPONSE = {
  meta: {
    dataset: "spans",
    start: 1_700_000_000_000,
    end: 1_700_003_600_000,
    interval: 3_600_000,
  },
  droppedEvents: [
    {
      type: "system",
      category: "span",
      outcome: "rate_limited",
      reason: "key_quota",
      start: 1_700_000_000_000,
      end: 1_700_003_600_000,
      count: 400,
      tags: ["unintentional"],
    },
  ],
  acceptedEvents: [
    {
      type: "system",
      category: "span",
      outcome: "accepted",
      reason: "accepted",
      start: 1_700_000_000_000,
      end: 1_700_003_600_000,
      count: 1000,
      tags: [],
    },
  ],
};

describe("find_dropped_events", () => {
  it("returns dropped and accepted buckets for an org", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/events-dropped/",
        () => HttpResponse.json(DROPPED_EVENTS_RESPONSE),
      ),
    );

    const result = await findDroppedEvents.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        dataset: "spans",
        projectSlug: null,
        statsPeriod: "24h",
        start: null,
        end: null,
        interval: null,
        outcome: null,
        reason: null,
      },
      context,
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(findDroppedEvents.outputSchema).toBe(findDroppedEventsOutputSchema);
    expect(findDroppedEventsOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "acceptedEvents": [
          {
            "category": "span",
            "count": 1000,
            "end": 1700003600000,
            "outcome": "accepted",
            "reason": "accepted",
            "start": 1700000000000,
            "tags": [],
          },
        ],
        "dataset": "spans",
        "droppedEvents": [
          {
            "category": "span",
            "count": 400,
            "end": 1700003600000,
            "outcome": "rate_limited",
            "reason": "key_quota",
            "start": 1700000000000,
            "tags": [
              "unintentional",
            ],
          },
        ],
        "interval": 3600000,
      }
    `);
  });

  it("forwards the errors dataset and outcome/reason filters to the API", async () => {
    let captured: URLSearchParams | undefined;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/events-dropped/",
        ({ request }) => {
          captured = new URL(request.url).searchParams;
          return HttpResponse.json(DROPPED_EVENTS_RESPONSE);
        },
      ),
    );

    await findDroppedEvents.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        dataset: "errors",
        projectSlug: null,
        statsPeriod: "24h",
        start: null,
        end: null,
        interval: null,
        outcome: "rate_limited",
        reason: "spike_protection",
      },
      context,
    );

    expect(captured?.get("dataset")).toBe("errors");
    expect(captured?.get("outcome")).toBe("rate_limited");
    expect(captured?.get("reason")).toBe("spike_protection");
  });

  it("replaces an interval Sentry rejects and says so", async () => {
    let captured: URLSearchParams | undefined;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/events-dropped/",
        ({ request }) => {
          captured = new URL(request.url).searchParams;
          return HttpResponse.json(DROPPED_EVENTS_RESPONSE);
        },
      ),
    );

    const result = await findDroppedEvents.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        dataset: "errors",
        projectSlug: null,
        statsPeriod: "30d",
        start: null,
        end: null,
        interval: "30d",
        outcome: null,
        reason: null,
      },
      context,
    );

    expect(captured?.get("interval")).toBe("1d");
    expect(getStructuredContent(result)).toMatchObject({
      intervalNote: expect.stringContaining(
        "Used interval '1d' instead of '30d'",
      ),
    });
  });

  describe("resolveDroppedEventsInterval", () => {
    it.each([
      // Accepted as-is.
      ["1h", 7 * 86_400, "1h"],
      ["1d", 30 * 86_400, "1d"],
      // Longer than a day.
      ["7d", 7 * 86_400, "1d"],
      ["1w", undefined, "1d"],
      // Does not divide a day.
      ["23h", 30 * 86_400, "1d"],
      ["50m", 86_400, "1h"],
      ["45m", 86_400, "45m"],
      // Too many buckets for the range.
      ["1h", 90 * 86_400, "3h"],
      ["1m", 86_400, "5m"],
    ])("maps %s over %s seconds to %s", (interval, rangeSeconds, expected) => {
      expect(
        resolveDroppedEventsInterval(interval, rangeSeconds).interval,
      ).toBe(expected);
    });

    it("keeps an accepted interval without a note", () => {
      expect(resolveDroppedEventsInterval("1h", 86_400)).toEqual({
        interval: "1h",
      });
    });

    it("drops an interval that is not a duration", () => {
      expect(resolveDroppedEventsInterval("hourly", 86_400)).toEqual({
        intervalNote: expect.stringContaining("Ignored interval 'hourly'"),
      });
    });
  });
});
