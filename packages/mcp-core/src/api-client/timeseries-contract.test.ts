import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { SentryApiService } from "./client";

describe("timeseries response contract", () => {
  afterEach(() => mswServer.resetHandlers());

  it("preserves transformation provenance and nullable metadata while omitting interval", async () => {
    const response = {
      meta: {
        dataset: "spans",
        start: 1_700_000_000_000,
        end: 1_700_000_300_000,
        ingestion: {
          status: "healthy",
          delaySeconds: 10,
          completeThrough: 1_700_000_300_000,
        },
      },
      timeSeries: [
        {
          yAxis: "count()",
          groupBy: [{ key: "release", value: null }],
          meta: {
            interval: 300_000,
            valueType: "integer",
            valueUnit: null,
            dataScanned: "partial",
          },
          values: [
            {
              timestamp: 1_700_000_000_000,
              value: null,
              comparisonValue: null,
              incomplete: false,
              filled: true,
              smoothed: false,
              comparisonFilled: false,
              comparisonSmoothed: true,
              sampleCount: 0,
              sampleRate: null,
              confidence: null,
            },
          ],
        },
      ],
    };
    const requests: URL[] = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/acme/events-timeseries/",
        ({ request }) => {
          requests.push(new URL(request.url));
          return HttpResponse.json(response);
        },
      ),
    );

    const api = new SentryApiService({
      host: "sentry.io",
      accessToken: "test-token",
    });
    expect(
      await api.getEventsTimeSeries({
        organizationSlug: "acme",
        dataset: "spans",
        query: "",
        yAxis: "count()",
        statsPeriod: "1h",
      }),
    ).toEqual(response);
    expect(requests).toHaveLength(1);
    expect([...requests[0].searchParams]).toEqual([
      ["dataset", "spans"],
      ["query", ""],
      ["yAxis", "count()"],
      ["statsPeriod", "1h"],
      ["referrer", "api.mcp.search-events"],
    ]);
  });
});
