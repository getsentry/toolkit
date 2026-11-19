import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { UserInputError } from "../../errors";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import type { ChartResult } from "../support/chart/schema";
import renderSentryChart from "./render-sentry-chart.js";

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
  dataset: "errors" as const,
  query: "level:error",
  yAxis: "count()",
  groupBy: null,
  projectSlug: null,
  period: "1h",
  start: null,
  end: null,
  interval: "15m",
  title: null,
};

describe("render_sentry_chart", () => {
  it("returns every bucket of the series", async () => {
    const result = await renderSentryChart.handler(baseParams, context);

    assertStructuredOnlyResult(result);
    expect(getStructuredContent<ChartResult>(result)).toMatchInlineSnapshot(`
      {
        "dataset": "errors",
        "groupBy": null,
        "ingestion": null,
        "interval": "15m",
        "peak": {
          "series": "count()",
          "time": "2025-09-10T23:30:00.000Z",
          "value": 140,
        },
        "query": "level:error",
        "series": [
          {
            "buckets": [
              {
                "incomplete": false,
                "outsideRetention": false,
                "time": "2025-09-10T23:00:00.000Z",
                "value": 56,
              },
              {
                "incomplete": false,
                "outsideRetention": false,
                "time": "2025-09-10T23:15:00.000Z",
                "value": 56,
              },
              {
                "incomplete": false,
                "outsideRetention": false,
                "time": "2025-09-10T23:30:00.000Z",
                "value": 140,
              },
              {
                "incomplete": true,
                "outsideRetention": false,
                "time": "2025-09-10T23:45:00.000Z",
                "value": 56,
              },
            ],
            "label": "count()",
            "total": 308,
          },
        ],
        "timeRange": {
          "end": null,
          "start": null,
          "statsPeriod": "1h",
        },
        "title": "count()",
        "url": "https://sentry-mcp-evals.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=level%3Aerror&project=-1&field=count%28%29&sort=-count%28%29&statsPeriod=1h&mode=aggregate&yAxis=count%28%29",
        "valueType": "integer",
        "valueUnit": null,
        "yAxis": "count()",
      }
    `);
  });

  it("asks Sentry for the top 5 groups and labels each series by its value", async () => {
    let captured: URLSearchParams | undefined;
    mswServer.use(
      http.get(TIMESERIES_URL, ({ request }) => {
        captured = new URL(request.url).searchParams;
        return HttpResponse.json({
          timeSeries: ["2.4.1", null].map((release, index) => ({
            yAxis: "p95(span.duration)",
            groupBy: [{ key: "release", value: release }],
            values: [
              {
                timestamp: 1757545200000,
                value: 120 - index,
                incomplete: false,
              },
            ],
            meta: {
              interval: 3600000,
              valueType: "duration",
              valueUnit: "millisecond",
              order: index,
              isOther: false,
            },
          })),
        });
      }),
    );

    const result = await renderSentryChart.handler(
      {
        ...baseParams,
        dataset: "spans",
        yAxis: "p95(span.duration)",
        groupBy: "release",
        period: null,
        interval: null,
      },
      context,
    );

    expect(Object.fromEntries(captured ?? [])).toMatchObject({
      dataset: "spans",
      yAxis: "p95(span.duration)",
      topEvents: "5",
      groupBy: "release",
      sort: "-p95(span.duration)",
      excludeOther: "1",
      statsPeriod: "24h",
    });
    const chart = getStructuredContent<ChartResult>(result);
    expect(chart.title).toBe("p95(span.duration) by release");
    expect(chart.valueUnit).toBe("millisecond");
    expect(chart.series.map(({ label, total }) => ({ label, total }))).toEqual([
      { label: "2.4.1", total: null },
      { label: "(none)", total: null },
    ]);
    expect(chart.peak).toEqual({
      series: "2.4.1",
      time: "2025-09-10T23:00:00.000Z",
      value: 120,
    });
  });

  it.each([
    ["every accessible project when projectSlug is omitted", null, ["-1"]],
    [
      "only the named project",
      "cloudflare-mcp",
      [expect.stringMatching(/^\d+$/)],
    ],
  ])("charts %s", async (_, projectSlug, expected) => {
    let projects: string[] | undefined;
    mswServer.use(
      http.get(TIMESERIES_URL, ({ request }) => {
        projects = new URL(request.url).searchParams.getAll("project");
        return HttpResponse.json({ timeSeries: [] });
      }),
    );

    await renderSentryChart.handler({ ...baseParams, projectSlug }, context);

    expect(projects).toEqual(expected);
    expect(projects).not.toEqual(projectSlug ? ["-1"] : []);
  });

  it("returns an empty chart when a grouped query matches nothing", async () => {
    mswServer.use(
      http.get(TIMESERIES_URL, () => HttpResponse.json({ timeSeries: [] })),
    );

    const chart = getStructuredContent<ChartResult>(
      await renderSentryChart.handler(
        { ...baseParams, groupBy: "release" },
        context,
      ),
    );

    expect(chart.series).toEqual([]);
    expect(chart.peak).toBeNull();
  });

  it.each([
    ["start without end", { start: "2025-09-10T00:00:00Z", period: null }],
    [
      "period with start and end",
      { start: "2025-09-10T00:00:00Z", end: "2025-09-11T00:00:00Z" },
    ],
    ["grouped profiles", { dataset: "profiles" as const, groupBy: "release" }],
  ])("rejects %s", async (_, overrides) => {
    await expect(
      renderSentryChart.handler({ ...baseParams, ...overrides }, context),
    ).rejects.toBeInstanceOf(UserInputError);
  });

  it("rejects an aggregate that returns text", async () => {
    mswServer.use(
      http.get(TIMESERIES_URL, () =>
        HttpResponse.json({
          timeSeries: [
            {
              yAxis: "latest_event()",
              values: [
                { timestamp: 1757545200000, value: "abc", incomplete: false },
              ],
              meta: { interval: 3600000, valueType: "string" },
            },
          ],
        }),
      ),
    );

    await expect(
      renderSentryChart.handler(
        { ...baseParams, yAxis: "latest_event()" },
        context,
      ),
    ).rejects.toBeInstanceOf(UserInputError);
  });
});
