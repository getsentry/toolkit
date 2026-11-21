import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { UserInputError } from "../../errors";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import type { ChartResult } from "../support/chart/schema";
import renderIssueChart from "./render-issue-chart.js";

const context = {
  constraints: { organizationSlug: null },
  accessToken: "access-token",
  userId: "1",
};

const TIMESERIES_URL =
  "https://sentry.io/api/0/organizations/sentry-mcp-evals/events-timeseries/";

const baseParams = {
  organizationSlug: "sentry-mcp-evals",
  regionUrl: null,
  issueId: "CLOUDFLARE-MCP-41",
  period: "5m",
  start: null,
  end: null,
};

/** Records the query params of each events-timeseries request. */
function captureTimeSeriesRequests(): URLSearchParams[] {
  const requests: URLSearchParams[] = [];
  mswServer.events.on("request:start", ({ request }) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/events-timeseries/")) {
      requests.push(url.searchParams);
    }
  });
  return requests;
}

describe("render_issue_chart", () => {
  afterEach(() => {
    mswServer.resetHandlers();
    mswServer.events.removeAllListeners();
  });

  it("charts an error issue's events and users as the issue page does", async () => {
    const requests = captureTimeSeriesRequests();

    const result = await renderIssueChart.handler(baseParams, context);

    assertStructuredOnlyResult(result);
    expect(getStructuredContent<ChartResult>(result)).toMatchInlineSnapshot(`
      {
        "dataset": "errors",
        "groupBy": null,
        "incomplete": [
          4,
        ],
        "ingestion": null,
        "interval": "1m",
        "outsideRetention": [],
        "peak": {
          "series": "Events",
          "time": "2025-09-10T23:58:00.000Z",
          "value": 235,
        },
        "query": "issue.id:6507376925",
        "series": [
          {
            "count": 421,
            "label": "Events",
            "total": 421,
            "values": [
              56,
              80,
              18,
              235,
              32,
            ],
          },
          {
            "count": null,
            "label": "Users",
            "total": null,
            "values": [
              13,
              18,
              4,
              53,
              7,
            ],
          },
        ],
        "timeRange": {
          "end": null,
          "start": null,
          "statsPeriod": "5m",
        },
        "times": [
          "2025-09-10T23:55:00.000Z",
          "2025-09-10T23:56:00.000Z",
          "2025-09-10T23:57:00.000Z",
          "2025-09-10T23:58:00.000Z",
          "2025-09-10T23:59:00.000Z",
        ],
        "title": "CLOUDFLARE-MCP-41: Error: Tool list_organizations is already registered",
        "tool": "render_issue_chart",
        "url": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41?statsPeriod=5m",
        "valueType": "integer",
        "valueUnit": null,
        "yAxis": "count(), count_unique(user)",
      }
    `);
    expect(Object.fromEntries(requests[0] ?? [])).toMatchObject({
      dataset: "errors",
      query: "issue.id:6507376925",
      interval: "1m",
      project: "4509062593708032",
    });
    expect(requests[0]?.getAll("yAxis")).toEqual([
      "count()",
      "count_unique(user)",
    ]);
  });

  // The errors dataset answers an issue-platform issue with every bucket 0.
  it("charts a performance issue from the issue platform, not as zeros", async () => {
    const requests = captureTimeSeriesRequests();

    const chart = getStructuredContent<ChartResult>(
      await renderIssueChart.handler(
        { ...baseParams, issueId: "PERF-N1-001", period: null },
        context,
      ),
    );

    expect(requests[0]?.get("dataset")).toBe("issuePlatform");
    expect(chart.dataset).toBe("issuePlatform");
    expect(chart.series[0]?.total).toBeGreaterThan(0);
  });

  it.each([
    ["the issue page's 4h buckets for the default 14 days", null, "4h", 84],
    ["20m buckets for 24 hours", "24h", "20m", 72],
    ["2h buckets for 7 days", "7d", "2h", 84],
  ])("uses %s", async (_, period, interval, buckets) => {
    const requests = captureTimeSeriesRequests();

    const chart = getStructuredContent<ChartResult>(
      await renderIssueChart.handler({ ...baseParams, period }, context),
    );

    expect(requests[0]?.get("interval")).toBe(interval);
    expect(requests[0]?.get("statsPeriod")).toBe(period ?? "14d");
    expect(chart.interval).toBe(interval);
    expect(chart.times).toHaveLength(buckets);
  });

  it("takes the issue from its URL and links back to it for the same range", async () => {
    const requests = captureTimeSeriesRequests();

    const chart = getStructuredContent<ChartResult>(
      await renderIssueChart.handler(
        {
          ...baseParams,
          organizationSlug: undefined,
          issueId: undefined,
          issueUrl: "https://sentry-mcp-evals.sentry.io/issues/6507376925/",
          period: null,
          start: "2025-09-10T00:00:00Z",
          end: "2025-09-11T00:00:00Z",
        },
        context,
      ),
    );

    expect(requests[0]?.get("interval")).toBe("20m");
    expect(chart.timeRange).toEqual({
      statsPeriod: null,
      start: "2025-09-10T00:00:00Z",
      end: "2025-09-11T00:00:00Z",
    });
    expect(new URL(chart.url).searchParams.get("start")).toBe(
      "2025-09-10T00:00:00Z",
    );
  });

  it("returns an empty chart when Sentry has no series", async () => {
    mswServer.use(
      http.get(TIMESERIES_URL, () => HttpResponse.json({ timeSeries: [] })),
    );

    const chart = getStructuredContent<ChartResult>(
      await renderIssueChart.handler(baseParams, context),
    );

    expect(chart.series).toEqual([]);
    expect(chart.peak).toBeNull();
    expect(chart.interval).toBe("1m");
  });

  it.each([
    ["no issue", { issueId: undefined }],
    ["start without end", { start: "2025-09-10T00:00:00Z", period: null }],
    [
      "end before start",
      {
        start: "2025-09-11T00:00:00Z",
        end: "2025-09-10T00:00:00Z",
        period: null,
      },
    ],
  ])("rejects %s", async (_, overrides) => {
    await expect(
      renderIssueChart.handler({ ...baseParams, ...overrides }, context),
    ).rejects.toBeInstanceOf(UserInputError);
  });
});
