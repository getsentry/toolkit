/** Explore time series through the real CLI router and HTTP transport. */

import { expect, test } from "vitest";
import { createE2EContext } from "../fixture.js";
import organizationFixture from "../fixtures/organization.json";
import { useTestConfigDir } from "../helpers.js";
import { TEST_ORG, TEST_PROJECT, TEST_TOKEN } from "../mocks/routes.js";
import { createMockServer } from "../mocks/server.js";

const getConfigDir = useTestConfigDir("e2e-explore-");
const start = Date.UTC(2026, 0, 1);
const end = start + 120_000;

/** Minimal sanitized timeseries response with numeric, missing, and string values. */
const response = {
  meta: {
    dataset: "spans",
    start,
    end,
    ingestion: { status: "healthy", delaySeconds: 30 },
  },
  timeSeries: [
    {
      yAxis: "count()",
      meta: {
        valueType: "integer",
        valueUnit: null,
        interval: 60_000,
        dataScanned: "partial",
      },
      values: [
        { timestamp: start, value: 0, incomplete: false },
        {
          timestamp: start + 60_000,
          value: null,
          incomplete: true,
          incompleteReason: "INGESTION_PENDING",
          sampleRate: 0.5,
          confidence: "low",
        },
      ],
    },
    {
      yAxis: "latest_event()",
      meta: { valueType: "string", valueUnit: null, interval: 60_000 },
      values: [{ timestamp: start, value: "00123", incomplete: false }],
    },
  ],
};

test("queries repeated aggregates and preserves metadata when projecting buckets", async () => {
  const requests: URL[] = [];
  const server = createMockServer(
    [
      {
        method: "GET",
        path: `/api/0/organizations/${TEST_ORG}/`,
        response: organizationFixture,
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
    const args = [
      "explore",
      `${TEST_ORG}/${TEST_PROJECT}`,
      "--time-series",
      "--dataset",
      "spans",
      "-F",
      "count()",
      "-F",
      "latest_event()",
      "--interval",
      "1m",
      "--period",
      "2026-01-01T00:00:00Z..2026-01-01T00:02:00Z",
      "--environment",
      "production,canary",
      "--query",
      "span.op:http.server",
      "--json",
    ];
    const result = await ctx.run(args);

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(requests).toHaveLength(1);
    const params = requests[0]!.searchParams;
    expect(params.getAll("yAxis")).toEqual(["count()", "latest_event()"]);
    expect(Object.fromEntries(params)).toEqual({
      dataset: "spans",
      yAxis: "latest_event()",
      interval: "1m",
      query: `project:${TEST_PROJECT} environment:[production,canary] span.op:http.server`,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    });
    expect(JSON.parse(result.stdout)).toEqual({
      ...response,
      dataset: "spans",
    });

    const projected = await ctx.run([...args, "--fields", "timestamp,value"]);

    expect(projected.exitCode, projected.stderr + projected.stdout).toBe(0);
    expect(JSON.parse(projected.stdout)).toEqual({
      ...response,
      dataset: "spans",
      timeSeries: [
        {
          ...response.timeSeries[0],
          values: [
            { timestamp: start, value: 0 },
            { timestamp: start + 60_000, value: null },
          ],
        },
        {
          ...response.timeSeries[1],
          values: [{ timestamp: start, value: "00123" }],
        },
      ],
    });
  } finally {
    server.stop();
  }
});
