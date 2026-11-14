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

test("SDK add and edit validate raw controls and persist them after reload", async () => {
  const originalFetch = (globalThis as { __originalFetch: typeof fetch })
    .__originalFetch;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(originalFetch);
  try {
    const sdk = createSentrySDK({
      token: TEST_TOKEN,
      url: server.url,
      env: { SENTRY_CONFIG_DIR: ctx.configDir, SENTRY_CLI_NO_TELEMETRY: "1" },
    });
    await sdk.dashboard.widget.add(
      {
        display: "line",
        query: ["count", "count"],
        transformAggregate: "all",
        transformFill: "zero",
        transformSmooth: "asap",
      },
      "test-org/123",
      "SDK chart",
    );
    expect(
      (await reload()).widgets?.[1]?.queries?.[0]?.transformations,
    ).toEqual({
      "0": ["fill(zero)", "smooth(asap)"],
      "1": ["fill(zero)", "smooth(asap)"],
    });
    await sdk.dashboard.widget.edit(
      {
        title: "SDK chart",
        transformAggregate: "2",
        transformSmooth: "ema",
        transformWindow: "7",
        transformAlpha: "0.25",
        transformOrder: "smooth-first",
      },
      "test-org/123",
    );
    expect(
      (await reload()).widgets?.[1]?.queries?.[0]?.transformations,
    ).toEqual({
      "0": ["fill(zero)", "smooth(asap)"],
      "1": ["smooth(ema,7,0.25)", "fill(zero)"],
    });
    lastUpdate = undefined;
    await expect(
      sdk.dashboard.widget.edit(
        {
          title: "SDK chart",
          transformAggregate: "2",
          transformSmooth: "ema",
          transformWindow: "0",
        },
        "test-org/123",
      ),
    ).rejects.toThrow("Invalid --transform-window");
    expect(lastUpdate).toBeUndefined();
  } finally {
    fetchSpy.mockRestore();
  }
});

test.each([
  ["spans", "line", "count"],
  ["logs", "area", "count"],
  ["metrics", "bar", "p50(value,latency,distribution,none)"],
])(
  "authors transformations on one duplicate aggregate in %s and reloads",
  async (dataset, display, aggregate) => {
    const result = await ctx.run([
      "dashboard",
      "widget",
      "add",
      "test-org/123",
      "New chart",
      "--dataset",
      dataset,
      "--display",
      display,
      "--query",
      aggregate,
      "--query",
      aggregate,
      "--transform-aggregate",
      "2",
      "--transform-fill",
      "zero",
      "--transform-smooth",
      "asap",
      "--transform-order",
      "smooth-first",
      "--json",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const reloaded = await reload();
    expect(reloaded.widgets?.[1]?.queries?.[0]?.transformations).toEqual({
      "1": ["smooth(asap)", "fill(zero)"],
    });
    expect(
      reloaded.widgets?.[0]?.queries?.map((query) => query.transformations),
    ).toEqual(
      savedDashboard.widgets?.[0]?.queries?.map(
        (query) => query.transformations,
      ),
    );
  },
);

test("omits the selector for a single aggregate and defaults new pairs to fill-first regardless of flag order", async () => {
  const result = await ctx.run([
    "dashboard",
    "widget",
    "add",
    "test-org/123",
    "Single",
    "--display",
    "line",
    "--query",
    "count",
    "--transform-smooth",
    "ema",
    "--transform-window",
    "7",
    "--transform-fill",
    "linear",
    "--json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect((await reload()).widgets?.[1]?.queries?.[0]?.transformations).toEqual({
    "0": ["fill(linear)", "smooth(ema,7)"],
  });
});

test("preserves omitted kinds verbatim and existing pair order on duplicate aggregates", async () => {
  const changed = await edit([
    "--transform-aggregate",
    "2",
    "--transform-fill",
    "locf",
  ]);
  expect(changed.exitCode, changed.stderr).toBe(0);
  expect((await reload()).widgets?.[0]?.queries?.[0]?.transformations).toEqual({
    "0": ["fill( linear )", "smooth( ema , 7 , 0.25 )"],
    "1": ["smooth(asap,7)", "fill(locf)"],
  });
  const first = await edit([
    "--transform-aggregate",
    "1",
    "--transform-fill",
    "zero",
  ]);
  expect(first.exitCode, first.stderr).toBe(0);
  expect(
    (await reload()).widgets?.[0]?.queries?.[0]?.transformations?.["0"],
  ).toEqual(["fill(zero)", "smooth( ema , 7 , 0.25 )"]);
  expect(
    lastUpdate?.widgets?.[0]?.queries?.[1]?.transformations,
  ).toBeUndefined();
  expect((await reload()).widgets?.[0]?.queries?.[1]?.transformations).toEqual({
    "0": ["fill(locf)"],
  });
});

test("replaces the complete smoothing configuration and uses automatic EMA alpha when omitted", async () => {
  const result = await edit([
    "--transform-aggregate",
    "1",
    "--transform-smooth",
    "ema",
    "--transform-window",
    "9",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(
    (await reload()).widgets?.[0]?.queries?.[0]?.transformations?.["0"],
  ).toEqual(["fill( linear )", "smooth(ema,9)"]);
});

test.each([
  {
    name: "removes filling while preserving smoothing",
    saved: ["smooth(asap,7)", "fill(zero)"],
    flags: ["--transform-fill", "none"],
    expected: ["smooth(asap,7)"],
  },
  {
    name: "defaults a newly formed pair to fill-first",
    saved: ["smooth(asap,7)"],
    flags: ["--transform-fill", "linear"],
    expected: ["fill(linear)", "smooth(asap,7)"],
  },
  {
    name: "explicitly reorders an existing pair",
    saved: ["fill(linear)", "smooth(asap,7)"],
    flags: ["--transform-order", "smooth-first"],
    expected: ["smooth(asap,7)", "fill(linear)"],
  },
  {
    name: "removes smoothing while preserving filling",
    saved: ["smooth(asap,7)", "fill(linear)"],
    flags: ["--transform-smooth", "none"],
    expected: ["fill(linear)"],
  },
  {
    name: "clears both kinds on a selected aggregate",
    saved: ["smooth(asap,7)", "fill(linear)"],
    flags: ["--transform-clear"],
    expected: undefined,
  },
])("$name", async ({ saved, flags, expected }) => {
  const query = stored.widgets![0].queries![0];
  query.transformations = { ...query.transformations, "1": saved };
  const result = await edit(["--transform-aggregate", "2", ...flags]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(
    (await reload()).widgets?.[0]?.queries?.[0]?.transformations?.["1"],
  ).toEqual(expected);
});

test("unrelated edits preserve transformations when the feature is disabled", async () => {
  enabled = false;
  for (const args of [
    ["--new-title", "Renamed"],
    ["--where", "span.op:http"],
  ]) {
    const result = await edit(args);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      (await reload()).widgets?.[0]?.queries?.map(
        (query) => query.transformations,
      ),
    ).toEqual(
      savedDashboard.widgets?.[0]?.queries?.map(
        (query) => query.transformations,
      ),
    );
    expect(
      lastUpdate?.widgets?.[0]?.queries?.[0]?.transformations,
    ).toBeUndefined();
  }
});

test("clears the first query even when the feature is disabled", async () => {
  enabled = false;
  const result = await edit([
    "--transform-aggregate",
    "all",
    "--transform-clear",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect((await reload()).widgets?.[0]?.queries?.[0]?.transformations).toEqual(
    {},
  );
  expect(lastUpdate?.widgets?.[0]?.queries?.[0]?.transformations).toEqual({});
});

test("surfaces feature-disabled errors without saving partial updates", async () => {
  enabled = false;
  const result = await edit([
    "--transform-aggregate",
    "1",
    "--transform-fill",
    "zero",
  ]);
  expect(result.exitCode).toBe(30);
  expect(result.stderr).toContain("Transformations are not enabled");
  expect(stored).toEqual(savedDashboard);
});

test.each([
  ["--query", "p95:span.duration", "--query", "count", "--query", "count"],
  ["--query", "count"],
  [
    "--query",
    "count",
    "--query",
    "count",
    "--query",
    "p95:span.duration",
    "--query",
    "avg:span.duration",
  ],
  [
    "--query",
    "count",
    "--transform-aggregate",
    "all",
    "--transform-fill",
    "linear",
  ],
  [
    "--query",
    "count",
    "--transform-aggregate",
    "1",
    "--transform-fill",
    "none",
    "--transform-smooth",
    "none",
  ],
])(
  "requires a complete explicit decision for every affected saved position %j",
  async (...args) => {
    const result = await edit(args);
    expect(result.exitCode).toBe(21);
    expect(result.stderr).toContain(
      "requires explicit --transform-fill and --transform-smooth",
    );
    expect(stored).toEqual(savedDashboard);
    expect(lastUpdate).toBeUndefined();
  },
);

test.each([false, true])(
  "rewrites aggregates and acknowledges removed positions with clear=%s",
  async (clear) => {
    const result = await edit([
      "--query",
      "p95:span.duration",
      "--query",
      "count",
      "--transform-aggregate",
      "all",
      ...(clear
        ? ["--transform-clear"]
        : [
            "--transform-fill",
            "none",
            "--transform-smooth",
            "ema",
            "--transform-window",
            "5",
            "--transform-alpha",
            "0.5",
          ]),
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const query = (await reload()).widgets?.[0]?.queries?.[0];
    expect(query?.aggregates).toEqual(["p95(span.duration)", "count()"]);
    expect(query?.transformations).toEqual(
      clear ? {} : { "0": ["smooth(ema,5,0.5)"], "1": ["smooth(ema,5,0.5)"] },
    );
  },
);

test("retains positional transformations when the aggregate list is unchanged", async () => {
  const result = await edit([
    "--query",
    "count",
    "--query",
    "count",
    "--query",
    "p95:span.duration",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  expect((await reload()).widgets?.[0]?.queries?.[0]?.transformations).toEqual(
    savedDashboard.widgets?.[0]?.queries?.[0]?.transformations,
  );
});

test("requires and allows clearing a removed stored empty position by its old number", async () => {
  stored.widgets![0].queries![0].transformations = { "2": [] };
  const result = await edit(["--query", "count"]);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain("saved aggregate 3");
  const corrected = await edit([
    "--query",
    "count",
    "--transform-aggregate",
    "3",
    "--transform-clear",
  ]);
  expect(corrected.exitCode, corrected.stderr).toBe(0);
  expect((await reload()).widgets?.[0]?.queries?.[0]?.transformations).toEqual(
    {},
  );
});

test.each([
  ["--display", "table"],
  ["--display", "stacked_area"],
  ["--dataset", "errors"],
])("rejects unsupported effective configurations %j", async (...args) => {
  const result = await edit(args);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain(
    "Transformations require dataset spans, logs, or tracemetrics and display line, area, or bar",
  );
  expect(stored).toEqual(savedDashboard);
});

test("considers saved transformations in later queries before changing display", async () => {
  const result = await edit([
    "--display",
    "table",
    "--transform-aggregate",
    "all",
    "--transform-clear",
  ]);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain(
    "Transformation flags edit only the first query",
  );
  expect(stored).toEqual(savedDashboard);
});

test("allows clearing transformations while switching to an unsupported display", async () => {
  stored.widgets![0].queries!.splice(1);
  const result = await edit([
    "--display",
    "table",
    "--transform-aggregate",
    "all",
    "--transform-clear",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  const widget = (await reload()).widgets?.[0];
  expect(widget?.displayType).toBe("table");
  expect(widget?.queries?.[0]?.transformations).toEqual({});
});

test.each([
  ["spans", "table"],
  ["errors", "line"],
])(
  "rejects authoring transformations for unsupported %s %s",
  async (dataset, display) => {
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
      "--transform-fill",
      "zero",
    ]);
    expect(result.exitCode).toBe(21);
    expect(result.stderr).toContain("Transformations require dataset");
    expect(stored).toEqual(savedDashboard);
  },
);

test.each([
  [["--transform-fill", "zero"], "Choose --transform-aggregate"],
  [["--transform-aggregate", "4", "--transform-clear"], "out of range"],
  [
    ["--transform-aggregate", "1", "--transform-smooth", "ema"],
    "requires --transform-window",
  ],
  [
    ["--transform-aggregate", "1", "--transform-window", "7"],
    "requires --transform-smooth",
  ],
  [
    [
      "--transform-aggregate",
      "1",
      "--transform-clear",
      "--transform-fill",
      "none",
    ],
    "cannot be combined",
  ],
  [
    ["--transform-aggregate", "3", "--transform-order", "smooth-first"],
    "requires both fill and smooth",
  ],
])(
  "rejects invalid transformation edits %j before saving",
  async (args, message) => {
    const result = await edit(args);
    expect(result.exitCode).toBe(21);
    expect(result.stderr).toContain(message);
    expect(stored).toEqual(savedDashboard);
    expect(lastUpdate).toBeUndefined();
  },
);

test.each(["add", "edit"])(
  "%s help explains selection, preservation, replacement, and clearing",
  async (command) => {
    const result = await ctx.run(["dashboard", "widget", command, "--help"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("--transform-aggregate");
    expect(result.stdout).toContain("1-based aggregate number");
    expect(result.stdout).toContain("replaces its complete configuration");
    expect(result.stdout).toContain("--transform-clear");
    expect(result.stdout).not.toContain("--transformations");
  },
);
