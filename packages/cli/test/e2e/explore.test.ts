/** Explore time series through the real CLI router and HTTP transport. */

import { expect, test } from "vitest";
import { createE2EContext } from "../fixture.js";
import organizationFixture from "../fixtures/organization.json";
import projectFixture from "../fixtures/project.json";
import { useTestConfigDir } from "../helpers.js";
import { TEST_ORG, TEST_PROJECT, TEST_TOKEN } from "../mocks/routes.js";
import { createMockServer } from "../mocks/server.js";

const getConfigDir = useTestConfigDir("e2e-explore-");
const start = Date.UTC(2026, 0, 1);
const end = start + 240_000;

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
        interval: 120_000,
        dataScanned: "partial",
      },
      values: [
        { timestamp: start, value: 0, incomplete: false },
        {
          timestamp: start + 120_000,
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
      meta: { valueType: "string", valueUnit: null, interval: 120_000 },
      values: [{ timestamp: start, value: "00123", incomplete: false }],
    },
  ],
};

test("combines -b buckets with -t period and preserves metadata when projecting repeated aggregates", async () => {
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
        path: `/api/0/projects/${TEST_ORG}/${TEST_PROJECT}/`,
        response: projectFixture,
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
      "-b",
      "2m",
      "--dataset",
      "spans",
      "-F",
      "count()",
      "-F",
      "latest_event()",
      "-t",
      "2026-01-01T00:00:00Z..2026-01-01T00:04:00Z",
      "--environment",
      "production,canary",
      "--query",
      "span.op:http.server OR span.status:internal_error",
      "--json",
    ];
    const result = await ctx.run(args);

    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(requests).toHaveLength(1);
    const params = requests[0].searchParams;
    expect(params.getAll("yAxis")).toEqual(["count()", "latest_event()"]);
    expect(Object.fromEntries(params)).toEqual({
      dataset: "spans",
      yAxis: "latest_event()",
      interval: "2m",
      project: projectFixture.id,
      query:
        "environment:[production,canary] (span.op:http.server OR span.status:internal_error)",
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
            { timestamp: start + 120_000, value: null },
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

test("keeps duplicate axes and ordered transformations through HTTP and rejects silently ignored transformations", async () => {
  const requests: URL[] = [];
  const transformed = {
    meta: response.meta,
    timeSeries: [
      {
        yAxis: "p95(span.duration)",
        meta: {
          valueType: "duration",
          valueUnit: "millisecond",
          interval: 120_000,
        },
        values: [
          {
            timestamp: start,
            value: null,
            incomplete: false,
            filled: false,
            smoothed: false,
          },
          {
            timestamp: start + 120_000,
            value: 150,
            incomplete: false,
            filled: true,
            smoothed: true,
          },
        ],
      },
      {
        yAxis: "p95(span.duration)",
        meta: {
          valueType: "duration",
          valueUnit: "millisecond",
          interval: 120_000,
        },
        values: [
          {
            timestamp: start,
            value: 0,
            incomplete: false,
            filled: true,
            smoothed: false,
          },
          {
            timestamp: start + 120_000,
            value: 300,
            incomplete: false,
            filled: false,
            smoothed: true,
          },
        ],
      },
    ],
  };
  let ignoreTransformations = false;
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
          return { body: ignoreTransformations ? response : transformed };
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
      `${TEST_ORG}/`,
      "--dataset",
      "spans",
      "-b",
      "1m",
      "-t",
      "5m",
      "-F",
      "p95(span.duration)",
      "-F",
      "p95(span.duration)",
      "--transform",
      "0:fill(linear)",
      "--transform",
      "1:smooth(sma,3)",
      "--transform",
      "0:smooth(ema,3,0.5)",
      "--transform",
      "1:fill(zero)",
      "--fresh",
    ];
    const result = await ctx.run([...args, "--json"]);
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(requests).toHaveLength(1);
    const params = requests[0]!.searchParams;
    expect(params.getAll("yAxis")).toEqual([
      "p95(span.duration)",
      "p95(span.duration)",
    ]);
    expect(params.getAll("transformations[0]")).toEqual([
      "fill(linear)",
      "smooth(ema,3,0.5)",
    ]);
    expect(params.getAll("transformations[1]")).toEqual([
      "smooth(sma,3)",
      "fill(zero)",
    ]);
    expect(params.get("interval")).toBe("1m");
    const expected = {
      ...transformed,
      dataset: "spans",
      timeSeries: [
        {
          ...transformed.timeSeries[0],
          axisIndex: 0,
          requestedTransformations: ["fill(linear)", "smooth(ema,3,0.5)"],
        },
        {
          ...transformed.timeSeries[1],
          axisIndex: 1,
          requestedTransformations: ["smooth(sma,3)", "fill(zero)"],
        },
      ],
    };
    expect(JSON.parse(result.stdout)).toEqual(expected);

    const projected = await ctx.run([
      ...args,
      "--json",
      "--fields",
      "timestamp,value,filled,smoothed",
    ]);
    expect(projected.exitCode, projected.stderr + projected.stdout).toBe(0);
    expect(JSON.parse(projected.stdout)).toEqual({
      ...expected,
      timeSeries: expected.timeSeries.map((series) => ({
        ...series,
        values: series.values!.map(
          ({ timestamp, value, filled, smoothed }) => ({
            timestamp,
            value,
            filled,
            smoothed,
          }),
        ),
      })),
    });

    const human = await ctx.run(args);
    expect(human.exitCode, human.stderr + human.stdout).toBe(0);
    expect(human.stdout).toContain("Axis 0");
    expect(human.stdout).toContain("Axis 1");
    expect(human.stdout).toContain(
      "Transformations: fill(linear) -> smooth(ema,3,0.5)",
    );
    expect(human.stdout).toContain("Interval: 2m");
    expect(human.stdout).toContain("Filled");
    expect(human.stdout).toContain("Smoothed");

    ignoreTransformations = true;
    const unsupported = await ctx.run([...args, "--json"]);
    expect(unsupported.exitCode).not.toBe(0);
    expect(unsupported.stderr).toContain("could not verify");
    expect(unsupported.stdout).toBe("");
    expect(requests).toHaveLength(4);
  } finally {
    server.stop();
  }
});
