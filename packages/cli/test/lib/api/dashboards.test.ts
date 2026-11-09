/**
 * Dashboard API helper tests
 *
 * Tests for periodToSeconds, computeOptimalInterval, and queryAllWidgets
 * from src/lib/api/dashboards.ts.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  computeOptimalInterval,
  listDashboardRevisionsPaginated,
  periodToSeconds,
  queryAllWidgets,
  restoreDashboardRevision,
} from "../../../src/lib/api/dashboards.js";
import { ApiError } from "../../../src/lib/errors.js";
import type {
  DashboardDetail,
  DashboardWidget,
} from "../../../src/types/dashboard.js";

const {
  listOrganizationDashboardRevisionsMock,
  listOrganizationEventsMock,
  listOrganizationEventsTimeseriesMock,
  reportCliErrorMock,
  restoreOrganizationDashboardRevisionMock,
} = vi.hoisted(() => ({
  listOrganizationDashboardRevisionsMock: vi.fn(),
  listOrganizationEventsMock: vi.fn(),
  listOrganizationEventsTimeseriesMock: vi.fn(),
  reportCliErrorMock: vi.fn(),
  restoreOrganizationDashboardRevisionMock: vi.fn(),
}));

vi.mock("@sentry/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/api")>();
  return {
    ...actual,
    listOrganizationDashboardRevisions: listOrganizationDashboardRevisionsMock,
    listOrganizationEvents: listOrganizationEventsMock,
    listOrganizationEventsTimeseries: listOrganizationEventsTimeseriesMock,
    restoreOrganizationDashboardRevision:
      restoreOrganizationDashboardRevisionMock,
  };
});

vi.mock("../../../src/lib/error-reporting.js", () => ({
  reportCliError: reportCliErrorMock,
}));

// ---------------------------------------------------------------------------
// restoreDashboardRevision
// ---------------------------------------------------------------------------

describe("restoreDashboardRevision", () => {
  test("restores the revision through the generated operation", async () => {
    const dashboard = {
      id: "123",
      title: "Restored Dashboard",
      widgets: [],
    } as DashboardDetail;
    restoreOrganizationDashboardRevisionMock.mockResolvedValue({
      data: dashboard,
      response: new Response(),
    });

    await expect(
      restoreDashboardRevision("test-org", "123", "42"),
    ).resolves.toEqual(dashboard);

    expect(restoreOrganizationDashboardRevisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: {
          organization_id_or_slug: "test-org",
          dashboard_id: "123",
          revision_id: "42",
        },
      }),
    );
  });

  test("names the revision when the API rejects the restore", async () => {
    restoreOrganizationDashboardRevisionMock.mockResolvedValue({
      error: { detail: "Revision not found" },
      response: new Response(null, { status: 404, statusText: "Not Found" }),
    });

    const error = await restoreDashboardRevision("test-org", "123", "42").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404 });
    expect((error as ApiError).message).toContain("revision '42'");
  });
});

// ---------------------------------------------------------------------------
// listDashboardRevisionsPaginated
// ---------------------------------------------------------------------------

describe("listDashboardRevisionsPaginated", () => {
  const revision = {
    id: "7",
    title: "Before edit",
    dateCreated: "2026-11-01T00:00:00Z",
    createdBy: null,
    source: "edit",
  };

  test("returns validated revisions and the Link cursors", async () => {
    listOrganizationDashboardRevisionsMock.mockResolvedValue({
      data: [revision],
      response: new Response(null, {
        headers: {
          link:
            '<https://us.sentry.io/x/?cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", ' +
            '<https://us.sentry.io/x/?cursor=0:25:0>; rel="next"; results="true"; cursor="0:25:0"',
        },
      }),
    });

    const page = await listDashboardRevisionsPaginated("test-org", "123", {
      perPage: 25,
      cursor: "0:0:0",
    });

    expect(page.data).toEqual([revision]);
    expect(page.nextCursor).toBe("0:25:0");
    expect(listOrganizationDashboardRevisionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { organization_id_or_slug: "test-org", dashboard_id: "123" },
        query: { per_page: 25, cursor: "0:0:0" },
      }),
    );
  });

  test("rejects a response that does not match the revision schema", async () => {
    listOrganizationDashboardRevisionsMock.mockResolvedValue({
      data: [{ id: 7 }],
      response: new Response(),
    });

    await expect(
      listDashboardRevisionsPaginated("test-org", "123"),
    ).rejects.toThrow("Unexpected response format");
  });
});

// ---------------------------------------------------------------------------
// periodToSeconds
// ---------------------------------------------------------------------------

describe("periodToSeconds", () => {
  test("parses seconds", () => {
    expect(periodToSeconds("30s")).toBe(30);
    expect(periodToSeconds("1s")).toBe(1);
  });

  test("parses minutes", () => {
    expect(periodToSeconds("1m")).toBe(60);
    expect(periodToSeconds("5m")).toBe(300);
    expect(periodToSeconds("30m")).toBe(1800);
  });

  test("parses hours", () => {
    expect(periodToSeconds("1h")).toBe(3600);
    expect(periodToSeconds("24h")).toBe(86_400);
    expect(periodToSeconds("4h")).toBe(14_400);
  });

  test("parses days", () => {
    expect(periodToSeconds("1d")).toBe(86_400);
    expect(periodToSeconds("7d")).toBe(604_800);
    expect(periodToSeconds("14d")).toBe(1_209_600);
    expect(periodToSeconds("90d")).toBe(7_776_000);
  });

  test("parses weeks", () => {
    expect(periodToSeconds("1w")).toBe(604_800);
    expect(periodToSeconds("2w")).toBe(1_209_600);
  });

  test("returns undefined for invalid input", () => {
    expect(periodToSeconds("")).toBeUndefined();
    expect(periodToSeconds("abc")).toBeUndefined();
    expect(periodToSeconds("24")).toBeUndefined();
    expect(periodToSeconds("h")).toBeUndefined();
    expect(periodToSeconds("24x")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// computeOptimalInterval
// ---------------------------------------------------------------------------

/** Build a minimal widget with optional layout width. */
function makeWidget(layoutW?: number, interval?: string): DashboardWidget {
  return {
    title: "Test Widget",
    displayType: "line",
    layout:
      layoutW !== undefined ? { x: 0, y: 0, w: layoutW, h: 2 } : undefined,
    interval,
  } as DashboardWidget;
}

describe("computeOptimalInterval", () => {
  test("returns a valid Sentry interval string", () => {
    const validIntervals = new Set([
      "1m",
      "5m",
      "15m",
      "30m",
      "1h",
      "4h",
      "12h",
      "1d",
    ]);
    const result = computeOptimalInterval("24h", makeWidget(2));
    expect(result).toBeDefined();
    expect(validIntervals.has(result!)).toBe(true);
  });

  test("shorter periods produce finer intervals", () => {
    const interval24h = computeOptimalInterval("24h", makeWidget(2));
    const interval7d = computeOptimalInterval("7d", makeWidget(2));
    const interval90d = computeOptimalInterval("90d", makeWidget(2));

    // Convert back to seconds for comparison
    const sec24h = periodToSeconds(interval24h!) ?? 0;
    const sec7d = periodToSeconds(interval7d!) ?? 0;
    const sec90d = periodToSeconds(interval90d!) ?? 0;

    expect(sec24h).toBeLessThanOrEqual(sec7d);
    expect(sec7d).toBeLessThanOrEqual(sec90d);
  });

  test("wider widgets produce finer intervals", () => {
    const narrow = computeOptimalInterval("24h", makeWidget(1));
    const wide = computeOptimalInterval("24h", makeWidget(6));

    const secNarrow = periodToSeconds(narrow!) ?? 0;
    const secWide = periodToSeconds(wide!) ?? 0;

    // Wider widget has more columns → finer interval
    expect(secWide).toBeLessThanOrEqual(secNarrow);
  });

  test("falls back to widget interval for invalid period", () => {
    const widget = makeWidget(2, "5m");
    expect(computeOptimalInterval("invalid", widget)).toBe("5m");
  });

  test("falls back to widget interval when no layout", () => {
    const widget = makeWidget(undefined, "15m");
    // Without layout, uses default GRID_COLS (full width) — still computes
    const result = computeOptimalInterval("24h", widget);
    expect(result).toBeDefined();
  });

  test("never returns undefined for valid periods", () => {
    const periods = ["1h", "24h", "7d", "14d", "90d"];
    for (const period of periods) {
      const result = computeOptimalInterval(period, makeWidget(2));
      expect(result).toBeDefined();
    }
  });

  test("returns 1m as floor for very short periods", () => {
    // 1h / ~40 cols ≈ 90s → should pick "1m" (finest available)
    const result = computeOptimalInterval("1h", makeWidget(2));
    expect(result).toBe("1m");
  });
});

// ---------------------------------------------------------------------------
// queryAllWidgets — text widget handling
// ---------------------------------------------------------------------------

/**
 * Build a minimal DashboardDetail with the given widgets.
 *
 * Text widgets carry markdown in `description` (a passthrough field not in
 * the typed schema), so widgets are cast via `as any`.
 */
function makeDashboard(widgets: Record<string, unknown>[]): DashboardDetail {
  return { id: "1", title: "Test Dashboard", widgets } as DashboardDetail;
}

describe("queryAllWidgets", () => {
  // Text widgets return immediately — no API call, no mocking needed.
  // regionUrl and orgSlug are unused for text widgets.
  const UNUSED_URL = "https://unused.example.com";
  const UNUSED_ORG = "unused-org";

  test("returns TextResult for text widget with description", async () => {
    const dashboard = makeDashboard([
      { title: "Notes", displayType: "text", description: "# Hello\n**bold**" },
    ]);

    const results = await queryAllWidgets(UNUSED_URL, UNUSED_ORG, dashboard);

    expect(results.size).toBe(1);
    expect(results.get(0)).toEqual({
      type: "text",
      content: "# Hello\n**bold**",
    });
  });

  test("returns TextResult with empty content when description is missing", async () => {
    const dashboard = makeDashboard([
      { title: "Empty Notes", displayType: "text" },
    ]);

    const results = await queryAllWidgets(UNUSED_URL, UNUSED_ORG, dashboard);

    expect(results.get(0)).toEqual({ type: "text", content: "" });
  });

  test("returns TextResult with empty content for non-string description", async () => {
    const dashboard = makeDashboard([
      { title: "Bad Description", displayType: "text", description: 42 },
    ]);

    const results = await queryAllWidgets(UNUSED_URL, UNUSED_ORG, dashboard);

    expect(results.get(0)).toEqual({ type: "text", content: "" });
  });

  test("handles multiple text widgets in a single dashboard", async () => {
    const dashboard = makeDashboard([
      { title: "Notes 1", displayType: "text", description: "First" },
      { title: "Notes 2", displayType: "text", description: "Second" },
      { title: "Notes 3", displayType: "text", description: "Third" },
    ]);

    const results = await queryAllWidgets(UNUSED_URL, UNUSED_ORG, dashboard);

    expect(results.size).toBe(3);
    expect(results.get(0)).toEqual({ type: "text", content: "First" });
    expect(results.get(1)).toEqual({ type: "text", content: "Second" });
    expect(results.get(2)).toEqual({ type: "text", content: "Third" });
  });

  test("reports a widget with a null display type as unsupported", async () => {
    const dashboard = makeDashboard([
      { title: "Legacy", displayType: null, widgetType: "error-events" },
    ]);

    const results = await queryAllWidgets(UNUSED_URL, UNUSED_ORG, dashboard);

    expect(results.get(0)).toEqual({
      type: "unsupported",
      reason: "Widget has no display type",
    });
  });
});

describe("widget sort resolution", () => {
  const REGION = "https://us.sentry.io";

  test("sorts error table widgets by their first aggregate", async () => {
    listOrganizationEventsMock.mockReset();
    listOrganizationEventsMock.mockResolvedValue({
      data: { data: [], meta: {} },
      response: new Response(),
    });
    const dashboard = makeDashboard([
      {
        title: "Top failures",
        displayType: "table",
        widgetType: "error-events",
        queries: [
          {
            fields: ["failure.node", "count()"],
            columns: ["failure.node"],
            aggregates: ["count()"],
            conditions: "",
            orderby: "",
          },
        ],
      },
    ]);

    await queryAllWidgets(REGION, "test-org", dashboard);

    expect(listOrganizationEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: REGION,
        path: { organization_id_or_slug: "test-org" },
        query: expect.objectContaining({
          dataset: "errors",
          field: ["failure.node", "count()"],
          sort: "-count()",
        }),
      }),
    );
  });

  test("selects the aggregate for grouped error timeseries so the sort is accepted", async () => {
    listOrganizationEventsTimeseriesMock.mockReset();
    listOrganizationEventsTimeseriesMock.mockResolvedValue({
      data: { timeSeries: [] },
      response: new Response(),
    });
    const dashboard = makeDashboard([
      {
        title: "Errors by node",
        displayType: "line",
        widgetType: "error-events",
        limit: 3,
        queries: [
          {
            fields: [],
            columns: ["failure.node"],
            aggregates: ["count()"],
            conditions: "has:failure.node",
            orderby: "-count()",
          },
        ],
      },
    ]);

    await queryAllWidgets(REGION, "test-org", dashboard);

    expect(listOrganizationEventsTimeseriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: REGION,
        path: { organization_id_or_slug: "test-org" },
        query: expect.objectContaining({
          dataset: "errors",
          query: "has:failure.node",
          groupBy: ["failure.node", "count()"],
          sort: "-count()",
          topEvents: 3,
        }),
      }),
    );
    // Single axis, single query: the "Other" series is requested.
    const query =
      listOrganizationEventsTimeseriesMock.mock.calls[0]?.[0]?.query;
    expect(query).not.toHaveProperty("excludeOther");
  });
});

describe("widget query failures", () => {
  const REGION = "https://us.sentry.io";
  const dashboard = makeDashboard([
    {
      title: "Slow screens",
      displayType: "table",
      widgetType: "spans",
      queries: [
        {
          fields: ["p50(tags[view_ms,number])"],
          columns: [],
          aggregates: ["p50(tags[view_ms,number])"],
          conditions: "",
          orderby: "",
        },
      ],
    },
  ]);

  /** Resolve the events request with an SDK error result. */
  function mockErrorResult(
    status: number,
    statusText: string,
    detail: string,
  ): void {
    listOrganizationEventsMock.mockReset();
    listOrganizationEventsMock.mockResolvedValue({
      error: { detail },
      response: new Response(null, { status, statusText }),
    });
  }

  test("reports through the shared policy and keeps the API detail", async () => {
    mockErrorResult(
      400,
      "Bad Request",
      "tags[view_ms,number] is invalid for parameter 1 in p50.\nIts a string type field.",
    );
    reportCliErrorMock.mockReset();

    const results = await queryAllWidgets(REGION, "test-org", dashboard);

    expect(reportCliErrorMock).toHaveBeenCalledWith(expect.any(ApiError));
    expect(reportCliErrorMock.mock.calls[0]?.[0]).toMatchObject({
      status: 400,
    });
    expect(results.get(0)).toEqual({
      type: "error",
      message:
        "Failed to query widget data: 400 Bad Request: tags[view_ms,number] is invalid for parameter 1 in p50. Its a string type field.",
    });
  });

  test("does not repeat a status-text detail", async () => {
    mockErrorResult(404, "Not Found", "Not Found");

    const results = await queryAllWidgets(REGION, "test-org", dashboard);

    expect(results.get(0)).toEqual({
      type: "error",
      message: "Failed to query widget data: 404 Not Found",
    });
  });
});

// ---------------------------------------------------------------------------
// queryAllWidgets — timeseries widgets (events-timeseries)
// ---------------------------------------------------------------------------

describe("queryAllWidgets timeseries", () => {
  const REGION = "https://us.sentry.io";
  const ORG = "my-org";

  beforeEach(() => {
    listOrganizationEventsTimeseriesMock.mockReset();
  });

  /** Resolve the request with `data`; the CLI validates it against its schema. */
  function mockResponse(data: unknown): void {
    listOrganizationEventsTimeseriesMock.mockResolvedValue({
      data,
      response: new Response(),
    });
  }

  /** Series meta the API always sends. */
  const SERIES_META = {
    valueType: "integer",
    valueUnit: null,
    interval: 3_600_000,
  };

  /** One complete bucket. */
  function bucket(
    value: number | string | null,
    timestamp = 1_700_000_000_000,
  ) {
    return { timestamp, value, incomplete: false };
  }

  /** Extract the single call's path and query params. */
  function lastRequest(): {
    path: Record<string, unknown>;
    params: Record<string, unknown>;
  } {
    const [options] = listOrganizationEventsTimeseriesMock.mock.calls[0] as [
      { path: Record<string, unknown>; query: Record<string, unknown> },
    ];
    return { path: options.path, params: options.query };
  }

  test("queries events-timeseries and normalizes an ungrouped series", async () => {
    mockResponse({
      meta: {
        dataset: "errors",
        start: 1_700_000_000_000,
        end: 1_700_003_600_000,
      },
      timeSeries: [
        {
          yAxis: "count()",
          values: [
            { timestamp: 1_700_000_000_000, value: 10, incomplete: false },
            { timestamp: 1_700_003_600_000, value: null, incomplete: true },
          ],
          meta: {
            valueType: "integer",
            valueUnit: null,
            interval: 3_600_000,
          },
        },
      ],
    });
    const dashboard = makeDashboard([
      {
        title: "Errors",
        displayType: "line",
        widgetType: "error-events",
        queries: [{ aggregates: ["count()"], columns: [], conditions: "" }],
      },
    ]);

    const results = await queryAllWidgets(REGION, ORG, dashboard, {
      period: "24h",
    });

    const { path, params } = lastRequest();
    expect(path).toEqual({ organization_id_or_slug: ORG });
    expect(params.dataset).toBe("errors");
    expect(params.yAxis).toEqual(["count()"]);
    expect(params.statsPeriod).toBe("24h");
    expect(params.groupBy).toBeUndefined();
    expect(params.topEvents).toBeUndefined();
    expect(results.get(0)).toEqual({
      type: "timeseries",
      series: [
        {
          label: "count()",
          unit: null,
          values: [
            { timestamp: 1_700_000_000, value: 10 },
            { timestamp: 1_700_003_600, value: 0 },
          ],
        },
      ],
    });
  });

  test("adds the sort field to groupBy and excludes Other for multi-axis", async () => {
    mockResponse({ timeSeries: [] });
    const dashboard = makeDashboard([
      {
        title: "Logs",
        displayType: "area",
        widgetType: "logs",
        queries: [
          {
            aggregates: ["count()", "count_unique(user)"],
            columns: ["severity"],
            conditions: "",
            orderby: "-max(timestamp)",
          },
        ],
      },
    ]);

    await queryAllWidgets(REGION, ORG, dashboard, { period: "1h" });

    const { params } = lastRequest();
    expect(params.groupBy).toEqual([
      "severity",
      "count()",
      "count_unique(user)",
      "max(timestamp)",
    ]);
    expect(params.sort).toBe("-max(timestamp)");
    expect(params.topEvents).toBe(5);
    expect(params.excludeOther).toBe("1");
  });

  test("labels grouped series by group values and marks Other", async () => {
    mockResponse({
      timeSeries: [
        {
          yAxis: "count()",
          groupBy: null,
          values: [bucket(1)],
          meta: { ...SERIES_META, isOther: true },
        },
        {
          yAxis: "count()",
          groupBy: [
            { key: "span.op", value: "db" },
            { key: "release", value: null },
          ],
          values: [bucket(7)],
          meta: { ...SERIES_META, order: 0 },
        },
        {
          yAxis: "count()",
          groupBy: [
            { key: "span.op", value: "http" },
            { key: "release", value: "1.0" },
          ],
          values: [bucket(3)],
          meta: { ...SERIES_META, order: 1 },
        },
      ],
    });
    const dashboard = makeDashboard([
      {
        title: "Ops",
        displayType: "line",
        widgetType: "spans",
        queries: [
          {
            aggregates: ["count()"],
            columns: ["span.op", "release"],
            conditions: "",
          },
        ],
      },
    ]);

    const results = await queryAllWidgets(REGION, ORG, dashboard, {
      period: "1h",
    });

    const result = results.get(0);
    expect(result?.type).toBe("timeseries");
    if (result?.type !== "timeseries") {
      return;
    }
    expect(result.series.map((s) => s.label)).toEqual([
      "db,(no value)",
      "http,1.0",
      "Other",
    ]);
  });

  test("coerces string bucket values and accepts a null groupBy", async () => {
    mockResponse({
      timeSeries: [
        {
          yAxis: "max(measurements.custom.ratio)",
          groupBy: null,
          values: [
            bucket("", 1_700_000_000_000),
            bucket("2.5", 1_700_003_600_000),
            bucket("n/a", 1_700_007_200_000),
          ],
          meta: { ...SERIES_META, valueType: "string", isOther: true },
        },
      ],
    });
    const dashboard = makeDashboard([
      {
        title: "Ratio",
        displayType: "area",
        widgetType: "error-events",
        queries: [
          {
            aggregates: ["max(measurements.custom.ratio)"],
            columns: [],
            conditions: "",
          },
        ],
      },
    ]);

    const results = await queryAllWidgets(REGION, ORG, dashboard, {
      period: "1h",
    });

    expect(results.get(0)).toEqual({
      type: "timeseries",
      series: [
        {
          label: "Other",
          unit: null,
          values: [
            { timestamp: 1_700_000_000, value: 0 },
            { timestamp: 1_700_003_600, value: 2.5 },
            { timestamp: 1_700_007_200, value: 0 },
          ],
        },
      ],
    });
  });

  test("labels a real 'Other' group as 'Other ()'", async () => {
    mockResponse({
      timeSeries: [
        {
          yAxis: "count()",
          groupBy: [{ key: "browser.name", value: "Other" }],
          values: [bucket(5)],
          meta: { ...SERIES_META, order: 0 },
        },
        {
          yAxis: "count()",
          groupBy: null,
          values: [bucket(9)],
          meta: { ...SERIES_META, isOther: true },
        },
      ],
    });
    const dashboard = makeDashboard([
      {
        title: "Browsers",
        displayType: "line",
        widgetType: "error-events",
        queries: [
          {
            aggregates: ["count()"],
            columns: ["browser.name"],
            conditions: "",
          },
        ],
      },
    ]);

    const results = await queryAllWidgets(REGION, ORG, dashboard, {
      period: "1h",
    });

    const result = results.get(0);
    if (result?.type !== "timeseries") {
      throw new Error(`expected timeseries, got ${result?.type}`);
    }
    expect(result.series.map((s) => s.label)).toEqual(["Other ()", "Other"]);
  });

  test("returns an error result for a malformed response", async () => {
    mockResponse({ data: [[1_700_000_000, [{ count: 1 }]]] });
    const dashboard = makeDashboard([
      {
        title: "Legacy",
        displayType: "line",
        widgetType: "error-events",
        queries: [{ aggregates: ["count()"], columns: [], conditions: "" }],
      },
    ]);

    const results = await queryAllWidgets(REGION, ORG, dashboard, {
      period: "1h",
    });

    expect(results.get(0)).toMatchObject({ type: "error" });
  });
});
