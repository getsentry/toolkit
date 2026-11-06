import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LLMProviderError } from "../../errors";
import * as provider from "../../internal/agents/provider-factory";
import { createTestContext } from "../../test-utils/context";
import { buildServer } from "../../server";
import * as agent from "../support/search-events/agent";
import { runSearchEvents } from "../support/search-events/search";
import searchLogs from "./search-logs";
import searchMetrics from "./search-metrics";
import searchTraces from "./search-traces";

vi.mock("@sentry/core/server", () => ({
  wrapMcpServerWithSentry: vi.fn((server) => server),
}));

const endpoint =
  "https://sentry.io/api/0/organizations/test-org/events-timeseries/";
const context = createTestContext({ sentryHost: "sentry.io" });
const configuration = {
  axes: [
    { yAxis: "count()", transformations: ["fill(zero)", "smooth(sma,3)"] },
    { yAxis: "count()", transformations: ["smooth(asap)", "fill(locf)"] },
  ],
  interval: "1h",
};
const baseParams = {
  organizationSlug: "test-org",
  projectSlug: null,
  regionUrl: null,
  limit: 10,
  includeExplanation: false,
  period: "24h",
};

function responseFor(axes = configuration.axes.map((axis) => axis.yAxis)) {
  return {
    timeSeries: axes.map((yAxis, index) => ({
      yAxis,
      meta: {
        interval: 3600000,
        valueType: "number",
        valueUnit: index === 0 ? null : "millisecond",
      },
      values: [
        {
          timestamp: 1757548800000,
          value: index === 0 ? null : 0,
          incomplete: false,
          filled: false,
          smoothed: false,
          comparisonValue: null,
          comparisonFilled: false,
          comparisonSmoothed: false,
        },
        {
          timestamp: 1757552400000,
          value: 4 + index,
          incomplete: index > 0,
          ...(index > 0 ? { incompleteReason: "INGESTION_PENDING" } : {}),
          filled: true,
          smoothed: true,
          comparisonValue: 0,
          comparisonFilled: false,
          comparisonSmoothed: true,
        },
      ],
    })),
  };
}

beforeEach(() => {
  vi.spyOn(provider, "hasAgentProvider").mockReturnValue(false);
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/test-org/", () =>
      HttpResponse.json({
        id: "1",
        slug: "test-org",
        name: "Test Org",
        features: [],
      }),
    ),
    http.get(
      "https://sentry.io/api/0/organizations/test-org/environments/",
      () => HttpResponse.json([]),
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("explicit time series", () => {
  it("preserves legacy untransformed searches when explicit settings are omitted", async () => {
    vi.mocked(provider.hasAgentProvider).mockReturnValue(true);
    vi.spyOn(agent, "searchEventsAgent").mockResolvedValue({
      result: {
        dataset: "spans",
        query: "span.op:db",
        fields: [],
        sort: "",
        environment: null,
        timeSeries: { axes: [{ yAxis: "count()" }], interval: "1m" },
        timeRange: { statsPeriod: "24h" },
        explanation: "translated",
      },
      toolCalls: [],
    });
    mswServer.use(
      http.get(endpoint, () =>
        HttpResponse.json({
          timeSeries: [
            {
              yAxis: "count()",
              meta: { interval: 60000 },
              values: [
                { timestamp: 1757548800000, value: 8, incomplete: false },
              ],
            },
          ],
        }),
      ),
    );
    const result = await searchTraces.handler(
      { ...baseParams, query: "database traffic per minute" },
      context,
    );
    expect(result).toContain("count() over time");
    expect(result).toContain("**Total**: 8");
  });
  it("exposes and dispatches the schema through MCP with equivalent structured and text results", async () => {
    mswServer.use(http.get(endpoint, () => HttpResponse.json(responseFor())));
    const server = buildServer({
      context: { ...context, constraints: { organizationSlug: "test-org" } },
      tools: { search_traces: searchTraces },
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "time-series-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      const traceTool = tools.tools.find(
        (tool) => tool.name === "search_traces",
      );
      expect(traceTool?.inputSchema.properties).toHaveProperty("timeSeries");
      const result = await client.callTool({
        name: "search_traces",
        arguments: {
          query: "span.op:db",
          period: "24h",
          timeSeries: configuration,
        },
      });
      expect(result.structuredContent).toMatchObject({
        dataset: "spans",
        query: "span.op:db",
        series: [{ axisIndex: 0 }, { axisIndex: 1 }],
      });
      const parsed = z
        .object({
          content: z.array(
            z.object({ type: z.literal("text"), text: z.string() }),
          ),
          structuredContent: z.record(z.string(), z.unknown()),
        })
        .parse(result);
      expect(JSON.parse(parsed.content[0]!.text)).toEqual(
        parsed.structuredContent,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("puts the executed auto interval in Explore links without changing the requested interval", async () => {
    const timeSeries = {
      axes: [{ yAxis: "count()", transformations: ["smooth(sma,3)"] }],
    };
    mswServer.use(
      http.get(endpoint, ({ request }) => {
        expect(new URL(request.url).searchParams.has("interval")).toBe(false);
        const response = responseFor(["count()"]);
        response.timeSeries[0]!.meta.interval = 900000;
        return HttpResponse.json(response);
      }),
    );
    const result = await searchTraces.handler(
      { ...baseParams, query: "span.op:db", period: "1h", timeSeries },
      context,
    );
    expect(result).toMatchObject({
      structuredContent: {
        requestedInterval: null,
        series: [{ intervalMs: 900000 }],
      },
    });
    const parsed = z
      .object({ structuredContent: z.object({ url: z.string() }) })
      .parse(result);
    expect(
      new URL(parsed.structuredContent.url).searchParams.get("interval"),
    ).toBe("900s");
  });

  it("rejects intervals that Explore would silently replace", async () => {
    mswServer.use(
      http.get(endpoint, () => {
        const response = responseFor(["count()"]);
        response.timeSeries[0]!.meta.interval = 60000;
        return HttpResponse.json(response);
      }),
    );
    await expect(
      searchTraces.handler(
        {
          ...baseParams,
          query: "span.op:db",
          timeSeries: { axes: [configuration.axes[0]!], interval: "1m" },
        },
        context,
      ),
    ).rejects.toThrow("Explore cannot preserve this bucket interval");
  });

  it("applies explicit settings before validating Seer's inferred chart", async () => {
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/test-org/", () =>
        HttpResponse.json({
          id: "1",
          slug: "test-org",
          name: "Test Org",
          features: ["mcp-search-events-seer-translate"],
        }),
      ),
      http.post(
        "https://sentry.io/api/0/organizations/test-org/search-agent/start/",
        () => HttpResponse.json({ run_id: 1, sentry_run_id: "run-id" }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/test-org/search-agent/state/run-id/",
        () =>
          HttpResponse.json({
            session: {
              status: "completed",
              final_response: {
                responses: [
                  {
                    query: "span.op:db",
                    group_by: [],
                    mode: "aggregates",
                    stats_period: "7d",
                    visualization: [
                      {
                        y_axes: ["avg(span.duration)"],
                        interval: null,
                        transformations: ["fill(locf)"],
                      },
                    ],
                  },
                ],
              },
            },
          }),
      ),
      http.get(endpoint, ({ request }) => {
        const params = new URL(request.url).searchParams;
        expect(params.get("interval")).toBe("1h");
        expect(params.get("statsPeriod")).toBe("24h");
        expect(params.getAll("yAxis")).toEqual(["count()", "count()"]);
        expect(params.getAll("transformations[0]")).toEqual([
          "fill(zero)",
          "smooth(sma,3)",
        ]);
        return HttpResponse.json(responseFor());
      }),
    );
    const result = await searchTraces.handler(
      {
        ...baseParams,
        query: "database traffic over time",
        timeSeries: configuration,
      },
      context,
    );
    expect(result).toMatchObject({
      structuredContent: { query: "span.op:db", requestedInterval: "1h" },
    });
  });
  it.each([
    {
      tool: searchTraces,
      dataset: "spans",
      query: "span.op:db",
      page: "traces",
    },
    {
      tool: searchLogs,
      dataset: "logs",
      query: "severity:error",
      page: "logs",
    },
    {
      tool: searchMetrics,
      dataset: "tracemetrics",
      query: "metric.name:tokens metric.type:counter metric.unit:-",
      page: "metrics",
    },
  ])(
    "executes ordered axes through $dataset without AI",
    async ({ tool, dataset, query, page }) => {
      const axes =
        dataset === "tracemetrics"
          ? configuration.axes.map((axis) => ({
              ...axis,
              yAxis: "sum(value,tokens,counter,-)",
            }))
          : configuration.axes;
      const timeSeries = { ...configuration, axes };
      const agentCall = vi.spyOn(agent, "searchEventsAgent");
      mswServer.use(
        http.get(endpoint, ({ request }) => {
          const params = new URL(request.url).searchParams;
          expect(params.get("dataset")).toBe(dataset);
          expect(params.get("query")).toBe(query);
          expect(params.getAll("yAxis")).toEqual(
            axes.map((axis) => axis.yAxis),
          );
          expect(params.getAll("transformations[0]")).toEqual([
            "fill(zero)",
            "smooth(sma,3)",
          ]);
          expect(params.getAll("transformations[1]")).toEqual([
            "smooth(asap)",
            "fill(locf)",
          ]);
          expect(params.get("interval")).toBe("1h");
          expect(params.get("statsPeriod")).toBe("24h");
          expect(params.has("field")).toBe(false);
          return HttpResponse.json(responseFor(axes.map((axis) => axis.yAxis)));
        }),
      );

      const params = z
        .object(tool.inputSchema)
        .parse({ ...baseParams, query, timeSeries });
      const result = await tool.handler(params, context);
      expect(result).toMatchObject({
        structuredContent: {
          dataset: dataset === "tracemetrics" ? "metrics" : dataset,
          query,
          requestedInterval: "1h",
          series: [
            {
              axisIndex: 0,
              yAxis: axes[0]?.yAxis,
              transformations: ["fill(zero)", "smooth(sma,3)"],
              valueUnit: null,
              buckets: [
                {
                  value: null,
                  comparisonValue: null,
                  transformation: {
                    filled: false,
                    smoothed: false,
                    comparisonFilled: false,
                    comparisonSmoothed: false,
                  },
                },
                { value: 4, comparisonValue: 0 },
              ],
              summary: { derivedMaximum: { value: 4 } },
            },
            {
              axisIndex: 1,
              yAxis: axes[1]?.yAxis,
              transformations: ["smooth(asap)", "fill(locf)"],
              valueUnit: "millisecond",
              buckets: [
                { value: 0 },
                {
                  value: 5,
                  incomplete: true,
                  transformation: { filled: true, smoothed: true },
                },
              ],
              summary: { derivedMaximum: { value: 0 } },
            },
          ],
        },
      });
      expect(agentCall).not.toHaveBeenCalled();
      const parsed = z
        .object({ structuredContent: z.object({ url: z.string() }) })
        .parse(result);
      expect(JSON.stringify(result)).not.toContain('"total"');
      const url = new URL(parsed.structuredContent.url);
      expect(url.pathname).toBe(`/explore/${page}/`);
      expect(url.searchParams.get("interval")).toBe("1h");
      const charts =
        page === "metrics"
          ? url.searchParams
              .getAll("metric")
              .flatMap((value) => JSON.parse(value).aggregateFields)
          : url.searchParams
              .getAll("aggregateField")
              .map((value) => JSON.parse(value));
      expect(charts).toEqual(
        axes.map((axis) => ({
          yAxes: [axis.yAxis],
          transformations: axis.transformations,
        })),
      );
    },
  );

  it("preserves explicit configuration after provider failure and on retry", async () => {
    vi.mocked(provider.hasAgentProvider).mockReturnValue(true);
    vi.spyOn(agent, "searchEventsAgent").mockRejectedValue(
      new LLMProviderError("provider unavailable"),
    );
    const requests: string[][] = [];
    mswServer.use(
      http.get(endpoint, ({ request }) => {
        const params = new URL(request.url).searchParams;
        requests.push(params.getAll("transformations[0]"));
        expect(params.get("interval")).toBe("1h");
        expect(params.get("statsPeriod")).toBe("24h");
        return HttpResponse.json(responseFor());
      }),
    );
    const params = {
      ...baseParams,
      query: "request volume over time",
      timeSeries: configuration,
    };
    const first = await searchTraces.handler(params, context);
    const retry = await searchTraces.handler(params, context);
    expect(first).toEqual(retry);
    expect(requests).toEqual([
      ["fill(zero)", "smooth(sma,3)"],
      ["fill(zero)", "smooth(sma,3)"],
    ]);
  });

  it("does not let translation replace explicit axes, interval, period, or dataset", async () => {
    vi.mocked(provider.hasAgentProvider).mockReturnValue(true);
    vi.spyOn(agent, "searchEventsAgent").mockResolvedValue({
      result: {
        dataset: "logs",
        query: "span.op:db",
        fields: [],
        sort: "",
        environment: null,
        timeSeries: { axes: [{ yAxis: "avg(span.duration)" }], interval: "1d" },
        timeRange: { statsPeriod: "7d" },
        explanation: "translated",
      },
      toolCalls: [],
    });
    mswServer.use(
      http.get(endpoint, ({ request }) => {
        const params = new URL(request.url).searchParams;
        expect(params.get("dataset")).toBe("spans");
        expect(params.getAll("yAxis")).toEqual(["count()", "count()"]);
        expect(params.get("interval")).toBe("1h");
        expect(params.get("statsPeriod")).toBe("24h");
        return HttpResponse.json(responseFor());
      }),
    );
    const result = await searchTraces.handler(
      { ...baseParams, query: "database traffic", timeSeries: configuration },
      context,
    );
    expect(result).toMatchObject({
      structuredContent: { query: "span.op:db", requestedInterval: "1h" },
    });
  });

  it("rejects unsupported datasets and table settings", async () => {
    await expect(
      runSearchEvents(
        { ...baseParams, dataset: "errors", timeSeries: configuration },
        context,
      ),
    ).rejects.toThrow(/search_traces, search_logs, and search_metrics/);
    await expect(
      searchTraces.handler(
        { ...baseParams, fields: ["span.op"], timeSeries: configuration },
        context,
      ),
    ).rejects.toThrow(/Grouped time series/);
  });

  it("rejects feature-off raw success rather than calling it transformed", async () => {
    mswServer.use(
      http.get(endpoint, () =>
        HttpResponse.json({
          timeSeries: configuration.axes.map(({ yAxis }) => ({
            yAxis,
            meta: { interval: 3600000 },
            values: [
              { timestamp: 1757548800000, value: 42, incomplete: false },
            ],
          })),
        }),
      ),
    );
    await expect(
      searchTraces.handler(
        { ...baseParams, query: "span.op:db", timeSeries: configuration },
        context,
      ),
    ).rejects.toThrow(/transformation|feature|unavailable/i);
  });
});
