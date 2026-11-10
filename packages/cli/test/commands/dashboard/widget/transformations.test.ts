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

test("SDK add and edit accept JSON transformations and preserve them after reload", async () => {
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
        query: ["count", "count"],
        transformations: '{"0":["fill(zero)"],"1":["smooth(asap)"]}',
      },
      "test-org/123",
      "SDK chart",
    );
    expect(
      (await reload()).widgets?.[1]?.queries?.[0]?.transformations,
    ).toEqual({
      "0": ["fill(zero)"],
      "1": ["smooth(asap)"],
    });
    await sdk.dashboard.widget.edit(
      { title: "SDK chart", transformations: '{"1":[]}' },
      "test-org/123",
    );
    expect(
      (await reload()).widgets?.[1]?.queries?.[0]?.transformations,
    ).toEqual({
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
  "authors independent transformations for duplicate aggregates in %s and reloads",
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
      "--transformations",
      '{"0":["fill(linear)","smooth(ema,7)"],"1":["smooth(asap)","fill(zero)"]}',
      "--json",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const reloaded = await reload();
    expect(reloaded.widgets?.[1]?.queries?.[0]?.transformations).toEqual({
      "0": ["fill(linear)", "smooth(ema,7)"],
      "1": ["smooth(asap)", "fill(zero)"],
    });
    expect(
      reloaded.widgets?.[0]?.queries?.map((query) => query.transformations),
    ).toEqual([
      {
        "0": ["fill( linear )", "smooth( ema , 7 , 0.25 )"],
        "1": ["smooth(asap,7)", "fill(zero)"],
        "2": [],
      },
      { "0": ["fill(locf)"] },
    ]);
  },
);

test("replaces and clears transformations by axis, preserving omitted axes and queries after reload", async () => {
  const changed = await edit([
    "--transformations",
    '{"1":["smooth(sma,3)","fill(locf)"]}',
  ]);
  expect(changed.exitCode, changed.stderr).toBe(0);
  expect((await reload()).widgets?.[0]?.queries?.[0]?.transformations).toEqual({
    "0": ["fill( linear )", "smooth( ema , 7 , 0.25 )"],
    "1": ["smooth(sma,3)", "fill(locf)"],
  });
  const cleared = await edit(["--transformations", '{"1":[]}']);
  expect(cleared.exitCode, cleared.stderr).toBe(0);
  expect(
    (await reload()).widgets?.[0]?.queries?.map(
      (query) => query.transformations,
    ),
  ).toEqual([
    { "0": ["fill( linear )", "smooth( ema , 7 , 0.25 )"] },
    { "0": ["fill(locf)"] },
  ]);
  expect(lastUpdate?.widgets?.[0]?.queries?.[1]).toEqual(
    expect.objectContaining({ id: "201" }),
  );
  expect(
    lastUpdate?.widgets?.[0]?.queries?.[1]?.transformations,
  ).toBeUndefined();
});

test("omission and an empty patch preserve transformations when the feature is disabled", async () => {
  enabled = false;
  for (const args of [
    ["--new-title", "Renamed"],
    ["--where", "span.op:http", "--transformations", "{}"],
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
  }
});

test("clears all transformations even when the feature is disabled", async () => {
  enabled = false;
  const result = await edit(["--transformations", '{"0":[],"1":[]}']);
  expect(result.exitCode, result.stderr).toBe(0);
  expect((await reload()).widgets?.[0]?.queries?.[0]?.transformations).toEqual(
    {},
  );
  expect(lastUpdate?.widgets?.[0]?.queries?.[0]?.transformations).toEqual({});
});

test("surfaces feature-disabled errors without saving partial updates", async () => {
  enabled = false;
  const result = await edit(["--transformations", '{"0":["fill(zero)"]}']);
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
])(
  "requires explicit correction after changing the aggregate list %j",
  async (...args) => {
    const result = await edit(args);
    expect(result.exitCode).toBe(21);
    expect(result.stderr).toContain("requires explicit transformations or []");
    expect(stored).toEqual(savedDashboard);
    expect(lastUpdate).toBeUndefined();
  },
);

test("reorders aggregates with explicit transformations and acknowledges removed empty positions", async () => {
  const result = await edit([
    "--query",
    "p95:span.duration",
    "--query",
    "count",
    "--transformations",
    '{"0":["smooth(ema,5,0.5)"],"1":["fill(zero)"],"2":[]}',
  ]);
  expect(result.exitCode, result.stderr).toBe(0);
  const query = (await reload()).widgets?.[0]?.queries?.[0];
  expect(query?.aggregates).toEqual(["p95(span.duration)", "count()"]);
  expect(query?.transformations).toEqual({
    "0": ["smooth(ema,5,0.5)"],
    "1": ["fill(zero)"],
  });
});

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

test("requires clearing a removed stored empty position", async () => {
  stored.widgets![0]!.queries![0]!.transformations = { "2": [] };
  const result = await edit(["--query", "count"]);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain("saved aggregate position 2");
  const corrected = await edit([
    "--query",
    "count",
    "--transformations",
    '{"2":[]}',
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
    "--transformations",
    '{"0":[],"1":[]}',
  ]);
  expect(result.exitCode).toBe(21);
  expect(result.stderr).toContain(
    "Transformation flags edit only the first query",
  );
  expect(stored).toEqual(savedDashboard);
});

test("allows clearing transformations while switching to an unsupported display", async () => {
  stored.widgets![0]!.queries!.splice(1);
  const result = await edit([
    "--display",
    "table",
    "--transformations",
    '{"0":[],"1":[]}',
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
      "--transformations",
      '{"0":["fill(zero)"]}',
    ]);
    expect(result.exitCode).toBe(21);
    expect(result.stderr).toContain("Transformations require dataset");
    expect(stored).toEqual(savedDashboard);
  },
);

test.each([
  ["not-json", "Expected a JSON object", 252],
  ['{"0":"fill(zero)"}', "Expected a JSON object mapping", 252],
  ['{"01":["fill(zero)"]}', "Invalid aggregate position", 252],
  ['{"__proto__":["fill(zero)"]}', "Invalid aggregate position", 252],
  ['{"constructor":["fill(zero)"]}', "Invalid aggregate position", 252],
  ['{"3":["fill(zero)"]}', "out of range", 21],
  ['{"3":[]}', "out of range", 21],
  [
    '{"0":["fill(zero)","fill(linear)"]}',
    "at most one fill and one smooth",
    252,
  ],
  ['{"0":["smooth(ema,3,0)"]}', "Invalid transformation", 252],
  ['{"0":["smooth(sma,0)"]}', "Invalid transformation", 252],
  ['{"0":["fill(unknown)"]}', "Invalid transformation", 252],
  ['{"0":[" fill(zero) "]}', "Invalid transformation", 252],
  ['{"0":["fill(zero\\n)"]}', "Invalid transformation", 252],
])("rejects malformed axis patches %s", async (patch, message, exitCode) => {
  const result = await edit(["--transformations", patch]);
  expect(result.exitCode).toBe(exitCode);
  expect(result.stderr).toContain(message);
  expect(stored).toEqual(savedDashboard);
  expect(lastUpdate).toBeUndefined();
});

test.each(["add", "edit"])(
  "%s help explains positional ordering and clear semantics",
  async (command) => {
    const result = await ctx.run(["dashboard", "widget", command, "--help"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("--transformations");
    expect(result.stdout).toContain("zero-based aggregate positions");
    expect(result.stdout).toContain("[] clears an axis");
  },
);
