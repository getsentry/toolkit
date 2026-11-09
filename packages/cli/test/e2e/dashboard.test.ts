import { expect, test } from "vitest";
import { createE2EContext } from "../fixture.js";
import organizationFixture from "../fixtures/organization.json";
import { useTestConfigDir } from "../helpers.js";
import { TEST_ORG, TEST_TOKEN } from "../mocks/routes.js";
import { createMockServer } from "../mocks/server.js";

const getConfigDir = useTestConfigDir("e2e-dashboard-transformations-");
const start = Date.UTC(2026, 0, 1);
const transformations = {
  "0": ["fill(locf)"],
  "1": ["smooth(sma,3)", "fill(zero)"],
};
const query = {
  aggregates: ["count()", "count()"],
  columns: ["span.op"],
  conditions: "span.duration:>0",
  orderby: "-count()",
  transformations,
};
const response = {
  responseVersion: "additive-field",
  meta: {
    dataset: "spans",
    start,
    end: start + 300_000,
    ingestion: { status: "healthy", delaySeconds: 30, source: "measured" },
    retention: "full",
  },
  timeSeries: ["http.server", "db", null].flatMap((group, groupIndex) =>
    [0, 1].map((axisIndex) => ({
      yAxis: "count()",
      groupBy: group === null ? null : [{ key: "span.op", value: group }],
      meta: {
        valueType: "number",
        valueUnit: "millisecond",
        interval: 300_000,
        order: groupIndex,
        isOther: group === null,
        dataScanned: "partial",
        additiveMetadata: true,
      },
      values: [
        {
          timestamp: start,
          value: axisIndex === 0 ? null : -1.25,
          incomplete: true,
          incompleteReason: "INGESTION_PENDING",
          comparisonValue: null,
          filled: false,
          smoothed: axisIndex === 1,
          comparisonFilled: false,
          comparisonSmoothed: true,
          sampleCount: 2,
          sampleRate: 0.5,
          confidence: "low",
          additiveProvenance: "retained",
        },
        {
          timestamp: start + 300_000,
          value: 0,
          incomplete: false,
          comparisonValue: 2.75,
          filled: true,
          smoothed: false,
          comparisonFilled: true,
          comparisonSmoothed: false,
        },
      ],
    })),
  ),
};

test("dashboard view executes saved transformations and retains full results in JSON and terminal tables", async () => {
  const requests: URL[] = [];
  const server = createMockServer(
    [
      {
        method: "GET",
        path: `/api/0/organizations/${TEST_ORG}/`,
        response: {
          ...organizationFixture,
          features: ["explore-interpolation-and-smoothing"],
        },
      },
      {
        method: "GET",
        path: `/api/0/organizations/${TEST_ORG}/dashboards/42/`,
        response: {
          id: "42",
          title: "Derived dashboard",
          period: "24h",
          projects: [1],
          environment: ["production"],
          widgets: [
            {
              title: "Saved transformations",
              displayType: "line",
              widgetType: "spans",
              interval: "5m",
              layout: { x: 0, y: 0, w: 1, h: 1 },
              queries: [query],
            },
          ],
        },
      },
      {
        method: "GET",
        path: `/api/0/organizations/${TEST_ORG}/events-timeseries/`,
        response: (request: Request) => {
          requests.push(new URL(request.url));
          return { body: response };
        },
      },
    ],
    { validTokens: [TEST_TOKEN] },
  );
  await server.start();
  try {
    const ctx = createE2EContext(getConfigDir(), server.url);
    await ctx.setAuthToken(TEST_TOKEN);
    const args = ["dashboard", "view", `${TEST_ORG}/42`];
    const json = await ctx.run([...args, "--json"]);
    expect(json.exitCode, json.stderr + json.stdout).toBe(0);
    expect(JSON.parse(json.stdout).widgets[0].data).toEqual({
      type: "transformed_timeseries",
      queries: [
        {
          queryIndex: 0,
          requestedInterval: "5m",
          yAxes: ["count()", "count()"],
          transformations,
          response,
        },
      ],
    });
    expect(requests[0]!.searchParams.getAll("yAxis")).toEqual([
      "count()",
      "count()",
    ]);
    expect(requests[0]!.searchParams.getAll("transformations[0]")).toEqual([
      "fill(locf)",
    ]);
    expect(requests[0]!.searchParams.getAll("transformations[1]")).toEqual([
      "smooth(sma,3)",
      "fill(zero)",
    ]);
    expect(requests[0]!.searchParams.get("interval")).toBe("5m");
    expect(requests[0]!.searchParams.get("environment")).toBe("production");
    expect(requests[0]!.searchParams.get("project")).toBe("1");

    const human = await ctx.run(args);
    expect(human.exitCode, human.stderr + human.stdout).toBe(0);
    for (const value of [
      "Transformations:",
      "Query 1, axis 1",
      "Query 1, axis 2",
      "http.server",
      "db",
      "Other",
      "null",
      "-1.25",
      "2.75",
      "millisecond",
      "300000",
      "comparisonSmoothed",
      "INGESTION_PENDING",
    ]) {
      expect(human.stdout).toContain(value);
    }
    const overridden = await ctx.run([...args, "--interval", "2m", "--json"]);
    expect(overridden.exitCode, overridden.stderr + overridden.stdout).toBe(0);
    expect(requests.at(-1)!.searchParams.get("interval")).toBe("2m");
    expect(JSON.parse(overridden.stdout).widgets[0].data.queries[0]).toEqual({
      queryIndex: 0,
      requestedInterval: "2m",
      yAxes: ["count()", "count()"],
      transformations,
      response,
    });
  } finally {
    server.stop();
  }
});
