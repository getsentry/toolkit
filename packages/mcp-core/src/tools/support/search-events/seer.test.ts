import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { SentryApiService } from "../../../api-client";
import { type SeerSearchDataset, translateWithSeer } from "./seer";

const baseUrl = "https://sentry.io/api/0/organizations/test-org";
const apiService = new SentryApiService({ accessToken: "test-token" });

function mockTranslation(
  visualization: unknown[],
  groupBy: string[] = [],
  logQuery?: string,
) {
  mswServer.use(
    http.get(`${baseUrl}/`, () =>
      HttpResponse.json({
        id: "1",
        slug: "test-org",
        name: "Test Org",
        features: ["mcp-search-events-seer-translate"],
      }),
    ),
    http.post(`${baseUrl}/search-agent/start/`, () =>
      HttpResponse.json({ run_id: 1, sentry_run_id: "run-uuid" }),
    ),
    http.get(`${baseUrl}/search-agent/state/run-uuid/`, () =>
      HttpResponse.json({
        session: {
          status: "completed",
          final_response: {
            responses: [
              {
                query: "span.op:http.client",
                group_by: groupBy,
                visualization,
                sort: "-count()",
                stats_period: "24h",
                mode: "aggregates",
                log_query: logQuery,
              },
            ],
          },
        },
      }),
    ),
  );
}

const translate = async (dataset: SeerSearchDataset = "spans") =>
  await translateWithSeer({
    apiService,
    organizationSlug: "test-org",
    dataset,
    query: "requests per hour",
  });

describe("Seer time series translation", () => {
  const datasets: SeerSearchDataset[] = ["spans", "logs", "metrics"];
  it.each(datasets)(
    "excludes non-bucketed Seer charts from %s time series",
    async (dataset) => {
      mockTranslation([
        { y_axes: ["count_unique(user)"], interval: null },
        { y_axes: ["count()"], interval: "1h" },
        { y_axes: ["count()"] },
      ]);

      expect((await translate(dataset))?.timeSeries).toEqual({
        axes: [{ yAxis: "count()" }],
        interval: "1h",
      });
    },
  );

  it("rejects transformations on a non-bucketed chart beside a time series", async () => {
    mockTranslation([
      { y_axes: ["count()"], interval: null, transformations: ["fill(zero)"] },
      { y_axes: ["count()"], interval: "1h" },
    ]);

    await expect(translate()).rejects.toThrow("supported time-series request");
  });

  it.each([null, "1h"])(
    "accepts null transformations with interval %s",
    async (interval) => {
      mockTranslation([
        { y_axes: ["count()"], interval, transformations: null },
      ]);

      expect(await translate()).toMatchObject({
        fields: ["count()"],
        timeSeries: interval
          ? { axes: [{ yAxis: "count()" }], interval }
          : null,
      });
    },
  );

  it.each([
    { interval: "0m", transformations: ["fill(zero)"] },
    { interval: "1h", transformations: ["smooth(sma,0)"] },
  ])(
    "rejects invalid transformed configuration $interval instead of raw fallback",
    async (chart) => {
      mockTranslation([{ y_axes: ["count()"], ...chart }]);
      await expect(translate()).rejects.toThrow(
        "unsupported time-series configuration",
      );
    },
  );
  it("preserves duplicate axes and their ordered transformations", async () => {
    mockTranslation([
      {
        y_axes: ["count()", "sum(span.duration)"],
        interval: "1h",
        transformations: ["fill(zero)", "smooth(sma,3)"],
      },
      {
        y_axes: ["count()"],
        interval: "1h",
        transformations: ["smooth(ema,5,0.3)", "fill(locf)"],
      },
    ]);

    expect((await translate())?.timeSeries).toEqual({
      axes: [
        {
          yAxis: "count()",
          transformations: ["fill(zero)", "smooth(sma,3)"],
        },
        {
          yAxis: "sum(span.duration)",
          transformations: ["fill(zero)", "smooth(sma,3)"],
        },
        {
          yAxis: "count()",
          transformations: ["smooth(ema,5,0.3)", "fill(locf)"],
        },
      ],
      interval: "1h",
    });
  });

  it("rejects transformed grouped output instead of returning a raw table", async () => {
    mockTranslation(
      [
        {
          y_axes: ["count()"],
          interval: "1h",
          transformations: ["fill(zero)"],
        },
      ],
      ["span.op"],
    );

    await expect(translate()).rejects.toThrow(
      "Grouped transformed time series",
    );
  });

  it("rejects incompatible chart intervals instead of dropping axes", async () => {
    mockTranslation([
      { y_axes: ["count()"], interval: "1h", transformations: ["fill(zero)"] },
      { y_axes: ["count()"], interval: "1d" },
    ]);

    await expect(translate()).rejects.toThrow("different intervals");
  });

  it("rejects transformed cross-event output instead of broadening the filter", async () => {
    mockTranslation(
      [
        {
          y_axes: ["count()"],
          interval: "1h",
          transformations: ["fill(zero)"],
        },
      ],
      [],
      "severity:error",
    );

    await expect(translate()).rejects.toThrow(
      "do not support cross-event filters",
    );
  });
});
