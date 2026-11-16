import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import createSentrySDK from "../../../../src/index.js";
import type { DashboardDetail } from "../../../../src/types/dashboard.js";
import { createE2EContext, type E2EContext } from "../../../fixture.js";
import { useTestConfigDir } from "../../../helpers.js";
import { TEST_TOKEN } from "../../../mocks/routes.js";
import { createMockServer } from "../../../mocks/server.js";

const savedDashboard: DashboardDetail = {
  id: "123",
  title: "Transformation authoring",
  widgets: [
    {
      id: "100",
      title: "Counts",
      displayType: "line",
      widgetType: "spans",
      layout: { x: 0, y: 0, w: 3, h: 2 },
      queries: [
        {
          id: "200",
          name: "Primary",
          conditions: "",
          aggregates: ["count()", "count()", "p95(span.duration)"],
          transformations: {
            "0": ["fill( linear )", "smooth( ema , 7 , 0.25 )"],
            "1": ["smooth(asap,7)", "fill(zero)"],
            "2": [],
          },
        },
        {
          id: "201",
          name: "Secondary",
          conditions: "span.op:db",
          aggregates: ["count()"],
          transformations: { "0": ["fill(locf)"] },
        },
      ],
    },
  ],
};

let stored: DashboardDetail;
let ctx: E2EContext;
let enabled: boolean;
let lastUpdate: DashboardDetail | undefined;
const getConfigDir = useTestConfigDir("dashboard-transformation-authoring-");
const endpoint = "/api/0/organizations/test-org/dashboards/123/";
const server = createMockServer(
  [
    {
      method: "GET",
      path: endpoint,
      response: () => ({
        body: stored,
        headers: { "Cache-Control": "no-store" },
      }),
    },
    {
      method: "PUT",
      path: endpoint,
      response: async (req: Request) => {
        const update: DashboardDetail = { ...(await req.json()), id: "123" };
        lastUpdate = structuredClone(update);
        for (const [widgetIndex, widget] of (update.widgets ?? []).entries()) {
          const existingWidget = stored.widgets?.find(
            (saved) => widget.id !== undefined && saved.id === widget.id,
          );
          widget.id ??= String(100 + widgetIndex);
          for (const [queryIndex, query] of (widget.queries ?? []).entries()) {
            if (
              !enabled &&
              Object.keys(query.transformations ?? {}).length > 0
            ) {
              return {
                status: 400,
                body: {
                  detail:
                    "Transformations are not enabled for this organization.",
                },
              };
            }
            const existingQuery = existingWidget?.queries?.find(
              (saved) => query.id !== undefined && saved.id === query.id,
            );
            if (existingQuery && query.transformations === undefined) {
              query.transformations = existingQuery.transformations;
            }
            if (
              Object.keys(query.transformations ?? {}).some(
                (index) => Number(index) >= (query.aggregates?.length ?? 0),
              )
            ) {
              return {
                status: 400,
                body: {
                  detail:
                    "Transformations index must match an aggregate position.",
                },
              };
            }
            query.id ??= String(200 + widgetIndex * 10 + queryIndex);
          }
        }
        stored = update;
        return { body: stored };
      },
    },
  ],
  { validTokens: [TEST_TOKEN] },
);

beforeAll(async () => {
  await server.start();
});
afterAll(() => {
  server.stop();
});
beforeEach(async () => {
  stored = structuredClone(savedDashboard);
  enabled = true;
  lastUpdate = undefined;
  ctx = createE2EContext(getConfigDir(), server.url);
  await ctx.setAuthToken(TEST_TOKEN);
});

async function reload(): Promise<DashboardDetail> {
  const result = await ctx.run(["api", endpoint]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

async function edit(args: string[]) {
  return await ctx.run([
    "dashboard",
    "widget",
    "edit",
    "test-org/123",
    "--index",
    "0",
    ...args,
    "--json",
  ]);
}

const SAVED_FIRST = ["fill( linear )", "smooth( ema , 7 , 0.25 )"];
const SAVED_SECOND = ["smooth(asap,7)", "fill(zero)"];

function firstQuery(dashboard: DashboardDetail, widget = 0) {
  return dashboard.widgets?.[widget]?.queries?.[0];
}

test("SDK add and edit take transformed series and keep them after reload", async () => {
  const originalFetch = (globalThis as { __originalFetch: typeof fetch })
    .__originalFetch;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(originalFetch);
  try {
    const sdk = createSentrySDK({
      token: TEST_TOKEN,
      url: server.url,
      env: {
        SENTRY_CONFIG_DIR: ctx.configDir,
        SENTRY_CLI_NO_TELEMETRY: "1",
      },
    });
    await sdk.dashboard.widget.add(
      {
        display: "line",
        query: ["fill(count, zero)", "smooth(count, asap)"],
      },
      "test-org/123",
      "SDK chart",
    );
    expect(firstQuery(await reload(), 1)?.transformations).toEqual({
      "0": ["fill(zero)"],
      "1": ["smooth(asap)"],
    });
    await sdk.dashboard.widget.edit(
      { title: "SDK chart", transform: ["count#2"] },
      "test-org/123",
    );
    expect(firstQuery(await reload(), 1)?.transformations).toEqual({
      "0": ["fill(zero)"],
    });
  } finally {
    fetchSpy.mockRestore();
  }
});

test.each([
  ["spans", "line", "count"],
  ["logs", "area", "count"],
  ["metrics", "bar", "p50(value,latency,distribution,none)"],
])(
  "add writes transformations around duplicate %s aggregates and reloads",
  async (dataset, display, aggregate) => {
    const result = await ctx.run([
      "dashboard",
      "widget",
      "add",
      "test-org/123",
      "Smoothed",
      "--dataset",
      dataset,
      "--display",
      display,
      "--query",
      aggregate,
      "--query",
      `smooth(fill(${aggregate}, linear), ema, 7)`,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(firstQuery(await reload(), 1)?.transformations).toEqual({
      "1": ["fill(linear)", "smooth(ema,7)"],
    });
  },
);

test("--transform sets one series and keeps the others and later queries", async () => {
  const result = await edit([
    "--transform",
    "fill(p95:span.duration, locf)",
    "--transform",
    "count#1",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  const widget = (await reload()).widgets?.[0];
  expect(widget?.queries?.[0]?.transformations).toEqual({
    "1": SAVED_SECOND,
    "2": ["fill(locf)"],
  });
  expect(widget?.queries?.[1]?.transformations).toEqual({
    "0": ["fill(locf)"],
  });
});

test("--transform asks which of several equal series it means", async () => {
  const result = await edit(["--transform", "smooth(count, sma, 5)"]);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain("the widget has 2 count() series");
  expect(result.stderr).toContain(
    "smooth(count#1,sma,5)  (aggregate 1, now smooth(fill(count(),linear),ema,7,0.25))",
  );
  expect(result.stderr).toContain(
    "smooth(count#2,sma,5)  (aggregate 2, now fill(smooth(count(),asap,7),zero))",
  );
  expect(lastUpdate).toBeUndefined();
});

test.each([
  [
    ["--transform", "fill(avg:span.duration, zero)"],
    "no avg(span.duration) series",
  ],
  [["--transform", "count#3"], "#3 names none of them"],
  [
    ["--transform", "count#1", "--transform", "fill(count#1, zero)"],
    'which --transform "count#1" already sets',
  ],
  [
    [
      "--query",
      "count",
      "--query",
      "fill(count, zero)",
      "--transform",
      "count#2",
    ],
    "which --query already transforms",
  ],
  [["--query", "count#1"], "--query lists every series in order"],
])("rejects %j", async (args, message) => {
  const result = await edit(args);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain(message);
  expect(lastUpdate).toBeUndefined();
});

test("--query keeps each series' transformations wherever it moves", async () => {
  const result = await edit([
    "--query",
    "p95:span.duration",
    "--query",
    "count",
    "--query",
    "count",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(firstQuery(await reload())?.transformations).toEqual({
    "1": SAVED_FIRST,
    "2": SAVED_SECOND,
  });
});

test("--query replaces what a series it transforms had, and says what it removed", async () => {
  const result = await edit(["--query", "fill(count, zero)"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toContain(
    "Removed fill(smooth(count(),asap,7),zero): --query no longer lists count() (aggregate 2).",
  );
  expect(firstQuery(await reload())?.transformations).toEqual({
    "0": ["fill(zero)"],
  });
});

test("unrelated edits leave transformations to Sentry, even when the feature is off", async () => {
  enabled = false;
  const result = await edit(["--new-title", "Renamed"]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(lastUpdate?.widgets?.[0]?.queries?.[0]).not.toHaveProperty(
    "transformations",
  );
  expect(firstQuery(await reload())?.transformations).toEqual(
    savedDashboard.widgets?.[0]?.queries?.[0]?.transformations,
  );
});

test("an unchanged series list sends no transformations", async () => {
  enabled = false;
  const result = await edit([
    "--query",
    "count",
    "--query",
    "count",
    "--query",
    "p95:span.duration",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(lastUpdate?.widgets?.[0]?.queries?.[0]).not.toHaveProperty(
    "transformations",
  );
});

test("clears every transformation even when the feature is off", async () => {
  enabled = false;
  const result = await edit([
    "--transform",
    "count#1",
    "--transform",
    "count#2",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(firstQuery(await reload())?.transformations).toEqual({});
});

test("surfaces the feature being off without saving", async () => {
  enabled = false;
  const result = await edit(["--transform", "fill(p95:span.duration, zero)"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("not enabled for this organization");
  expect(stored).toEqual(savedDashboard);
});

test("shows where a series stops parsing", async () => {
  const result = await edit(["--transform", "fill(count, bogus)"]);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain(
    'Invalid --transform "fill(count, bogus)": Expected "linear", "locf", or "zero" but "b" found.',
  );
  expect(result.stderr).toContain("  fill(count, bogus)\n              ^");
  expect(lastUpdate).toBeUndefined();
});

test.each([
  ["fill(fill(count, zero), linear)", "at most one fill transformation"],
  ["smooth(count, sma, 0)", "Window size 0 must be a positive integer"],
  ["smooth(count, ema, 7, 2)", "Smoothing factor 2 must be greater than 0"],
  ["smooth(count, sma)", 'Expected ","'],
])("rejects the malformed series %s", async (series, message) => {
  const result = await edit(["--transform", series]);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain(message);
  expect(lastUpdate).toBeUndefined();
});

test.each([
  ["--display", "table"],
  ["--display", "stacked_area"],
  ["--dataset", "errors"],
])("names the flags that clear transformations before %j", async (...args) => {
  const result = await edit(args);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain(
    "Transformations need dataset spans, logs, tracemetrics and display line, area, bar",
  );
  expect(result.stderr).toContain(
    "--transform 'count()#1' --transform 'count()#2'",
  );
  expect(stored).toEqual(savedDashboard);
});

test("counts the transformations of later queries before changing display", async () => {
  const result = await edit([
    "--display",
    "table",
    "--transform",
    "count#1",
    "--transform",
    "count#2",
  ]);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain("they edit only the first query");
  expect(stored).toEqual(savedDashboard);
});

test("clears transformations while switching to a display without them", async () => {
  stored.widgets![0].queries!.splice(1);
  const result = await edit([
    "--display",
    "table",
    "--transform",
    "count#1",
    "--transform",
    "count#2",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  const widget = (await reload()).widgets?.[0];
  expect(widget?.displayType).toBe("table");
  expect(widget?.queries?.[0]?.transformations).toEqual({});
});

test.each([
  ["spans", "table"],
  ["errors", "line"],
])("add rejects transformations for %s %s", async (dataset, display) => {
  const result = await ctx.run([
    "dashboard",
    "widget",
    "add",
    "test-org/123",
    "Unsupported",
    "--dataset",
    dataset,
    "--display",
    display,
    "--query",
    "fill(count, zero)",
  ]);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain("Transformations need dataset");
  expect(stored).toEqual(savedDashboard);
});

test.each(["add", "edit"])(
  "%s help shows the transformation syntax",
  async (command) => {
    const result = await ctx.run(["dashboard", "widget", command, "--help"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "smooth(fill(p95:span.duration, linear), ema, 7)",
    );
    if (command === "edit") {
      expect(result.stdout).toContain("--transform");
      expect(result.stdout).toContain("add #<n> to pick");
    }
  },
);
