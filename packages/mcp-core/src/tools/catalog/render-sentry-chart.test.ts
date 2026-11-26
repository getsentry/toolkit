import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it } from "vitest";
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
  afterEach(() => mswServer.resetHandlers());

  it("returns every bucket of the series", async () => {
    const result = await renderSentryChart.handler(baseParams, context);

    assertStructuredOnlyResult(result);
    expect(getStructuredContent<ChartResult>(result)).toMatchInlineSnapshot(`
      {
        "dataset": "errors",
        "groupBy": null,
        "incomplete": [
          3,
        ],
        "ingestion": null,
        "interval": "15m",
        "outsideRetention": [],
        "peak": {
          "series": "count()",
          "time": "2025-09-10T23:30:00.000Z",
          "value": 140,
        },
        "query": "level:error",
        "series": [
          {
            "count": 308,
            "label": "count()",
            "total": 308,
            "values": [
              56,
              56,
              140,
              56,
            ],
          },
        ],
        "timeRange": {
          "end": null,
          "start": null,
          "statsPeriod": "1h",
        },
        "times": [
          "2025-09-10T23:00:00.000Z",
          "2025-09-10T23:15:00.000Z",
          "2025-09-10T23:30:00.000Z",
          "2025-09-10T23:45:00.000Z",
        ],
        "title": "count()",
        "tool": "render_sentry_chart",
        "url": "https://sentry-mcp-evals.sentry.io/explore/discover/homepage/?dataset=errors&queryDataset=error-events&query=level%3Aerror&project=-1&field=count%28%29&sort=-count%28%29&statsPeriod=1h&mode=aggregate&yAxis=count%28%29",
        "valueType": "integer",
        "valueUnit": null,
        "yAxis": "count()",
      }
    `);
  });

  it("asks Sentry for the 5 groups with the most events, with each group's count", async () => {
    let captured: URLSearchParams | undefined;
    mswServer.use(
      http.get(TIMESERIES_URL, ({ request }) => {
        captured = new URL(request.url).searchParams;
        return HttpResponse.json({
          timeSeries: ["2.4.1", null].flatMap((release, index) =>
            [
              ["p95(span.duration)", [120 - index, null]],
              ["count()", [40 - index, 0]],
            ].map(([yAxis, values]) => ({
              yAxis,
              groupBy: [{ key: "release", value: release }],
              values: (values as (number | null)[]).map((value, bucket) => ({
                timestamp: 1757545200000 + bucket * 3600000,
                value,
                incomplete: false,
              })),
              meta: {
                interval: 3600000,
                valueType: yAxis === "count()" ? "integer" : "duration",
                valueUnit: yAxis === "count()" ? null : "millisecond",
                order: index,
                isOther: false,
              },
            })),
          ),
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

    expect(captured?.getAll("yAxis")).toEqual([
      "p95(span.duration)",
      "count()",
    ]);
    expect(captured?.getAll("groupBy")).toEqual(["release", "count()"]);
    expect(Object.fromEntries(captured ?? [])).toMatchObject({
      dataset: "spans",
      topEvents: "5",
      sort: "-count()",
      excludeOther: "1",
      statsPeriod: "24h",
    });
    const chart = getStructuredContent<ChartResult>(result);
    expect(chart.title).toBe("p95(span.duration) by release");
    expect(chart.valueUnit).toBe("millisecond");
    expect(chart.times).toEqual([
      "2025-09-10T23:00:00.000Z",
      "2025-09-11T00:00:00.000Z",
    ]);
    expect(chart.series).toEqual([
      { label: "2.4.1", count: 40, total: null, values: [120, null] },
      { label: "(none)", count: 39, total: null, values: [119, null] },
    ]);
    expect(chart.peak).toBeNull();
  });

  // The errors dataset selects only the `groupBy` columns, so Sentry rejects
  // `sort=-count()` unless `count()` is also a `groupBy`.
  it("splits an errors chart by an attribute", async () => {
    const chart = getStructuredContent<ChartResult>(
      await renderSentryChart.handler(
        { ...baseParams, groupBy: "release", interval: "1h" },
        context,
      ),
    );

    expect(chart.title).toBe("count() by release");
    expect(chart.series).toHaveLength(5);
    for (const series of chart.series) {
      expect(series.count).toBeGreaterThan(0);
    }
  });

  // The busy releases have steady traffic; the sparse ones have 1 to 57
  // events, all at the 30s pageload cap, so ranking by p95 would pick them.
  it("charts the busiest releases, keeps empty buckets null, and stays small for 7d at 1h", async () => {
    const chart = getStructuredContent<ChartResult>(
      await renderSentryChart.handler(
        {
          ...baseParams,
          dataset: "spans",
          query: "is_transaction:true",
          yAxis: "p95(span.duration)",
          groupBy: "release",
          period: "7d",
          interval: "1h",
        },
        context,
      ),
    );

    expect(chart.times).toHaveLength(168);
    // "Open in Sentry" ranks the groups by event count too.
    const sentryLink = new URL(chart.url);
    expect(sentryLink.searchParams.get("aggregateSort")).toBe("-count()");
    expect(sentryLink.searchParams.getAll("aggregateField")).toEqual([
      JSON.stringify({ groupBy: "release" }),
      JSON.stringify({ yAxes: ["p95(span.duration)", "count()"] }),
    ]);
    expect(
      chart.series.map(({ label, count }) => [label.slice(0, 8), count]),
    ).toEqual([
      ["3f9c2e1a", 20160],
      ["8b41d07c", 10080],
      ["c05e9a3f", 3360],
      ["1d7f4b2e", 57],
      ["e2a86c91", 23],
    ]);
    for (const series of chart.series) {
      expect(series.values).toHaveLength(168);
      expect(series.values).not.toContain(0);
    }
    const sparse = chart.series[4]?.values ?? [];
    expect(sparse.filter((value) => value === null)).toHaveLength(164);
    expect(chart.peak).toBeNull();
    // 5 series of 168 buckets is about 12 KB; one object per bucket, as
    // before, came to about 200 KB.
    expect(JSON.stringify(chart).length).toBeLessThan(16 * 1024);
  });

  it.each([
    [
      "the metric's own count for a trace metric",
      "p95(value,http.request.duration,distribution,millisecond)",
      "count(value,http.request.duration,distribution,millisecond)",
    ],
    ["the aggregate when it names no metric", "p95(value)", "p95(value)"],
  ])("ranks metrics groups by %s", async (_, yAxis, rankBy) => {
    let captured: URLSearchParams | undefined;
    mswServer.use(
      http.get(TIMESERIES_URL, ({ request }) => {
        captured = new URL(request.url).searchParams;
        return HttpResponse.json({ timeSeries: [] });
      }),
    );

    await renderSentryChart.handler(
      { ...baseParams, dataset: "metrics", yAxis, groupBy: "release" },
      context,
    );

    expect(captured?.getAll("yAxis")).toEqual([...new Set([yAxis, rankBy])]);
    expect(captured?.get("sort")).toBe(`-${rankBy}`);
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

  it("links grouped errors charts to Discover with the group-by column", async () => {
    mswServer.use(
      http.get(TIMESERIES_URL, () => HttpResponse.json({ timeSeries: [] })),
    );

    const chart = getStructuredContent<ChartResult>(
      await renderSentryChart.handler(
        { ...baseParams, groupBy: "release" },
        context,
      ),
    );

    expect(new URL(chart.url).searchParams.getAll("field")).toEqual([
      "release",
      "count()",
    ]);
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

  // The errors dataset answers an issue-platform issue with every bucket 0,
  // which reads as a real answer.
  it.each([
    ["an issue short ID", "issue:PERF-N1-001"],
    ["an issue ID among other filters", "level:error issue.id:7890123456"],
    ["a list of issues", "issue.id:[7890123456,6507376925]"],
  ])("sends a chart of %s to render_issue_chart", async (_, query) => {
    const error = await renderSentryChart
      .handler({ ...baseParams, query }, context)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UserInputError);
    expect((error as Error).message).toContain("render_issue_chart");
  });

  it.each([
    ["excludes an issue", "!issue:CLOUDFLARE-MCP-41"],
    ["quotes issue: inside a value", 'message:"see issue:123"'],
  ])("charts a query that %s", async (_, query) => {
    const chart = getStructuredContent<ChartResult>(
      await renderSentryChart.handler({ ...baseParams, query }, context),
    );

    expect(chart.series[0]?.total).toBeGreaterThan(0);
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
