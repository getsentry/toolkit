import { beforeAll, beforeEach, afterAll, expect, test } from "vitest";
import type { DashboardDetail } from "../../../../src/types/dashboard.js";
import { createE2EContext, type E2EContext } from "../../../fixture.js";
import { useTestConfigDir } from "../../../helpers.js";
import { TEST_TOKEN } from "../../../mocks/routes.js";
import { createMockServer } from "../../../mocks/server.js";

const savedDashboard: DashboardDetail = {
  id: "123",
  title: "Saved pipelines",
  projects: [1],
  environment: ["production"],
  period: "24h",
  widgets: [
    {
      id: "100",
      title: "Transformed spans",
      displayType: "line",
      widgetType: "spans",
      layout: { x: 0, y: 0, w: 3, h: 2 },
      queries: [
        {
          id: "200",
          name: "Primary",
          conditions: "span.op:http.client",
          columns: [],
          aggregates: ["count()", "count()", "p95(span.duration)"],
          fields: ["count()", "count()", "p95(span.duration)"],
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
          columns: [],
          aggregates: ["count()"],
          fields: ["count()"],
          transformations: { "0": ["fill( linear )"] },
        },
      ],
    },
    {
      id: "101",
      title: "Other widget",
      displayType: "big_number",
      widgetType: "spans",
      layout: { x: 3, y: 0, w: 2, h: 1 },
      queries: [
        {
          id: "202",
          name: "",
          conditions: "",
          columns: [],
          aggregates: ["count()"],
          fields: ["count()"],
          transformations: { "0": ["fill(linear)"] },
        },
      ],
    },
  ],
};

let stored: DashboardDetail;
let ctx: E2EContext;
const getConfigDir = useTestConfigDir("dashboard-preservation-");
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
        for (const widget of update.widgets ?? []) {
          const existingWidget = stored.widgets?.find(
            (saved) => widget.id !== undefined && saved.id === widget.id,
          );
          for (const query of widget.queries ?? []) {
            if (Object.keys(query.transformations ?? {}).length > 0) {
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
  ctx = createE2EContext(getConfigDir(), server.url);
  await ctx.setAuthToken(TEST_TOKEN);
});

test.each([
  ["add", ["add", "New widget", "--display", "line", "--query", "count"]],
  ["delete another widget", ["delete", "--index", "1", "--yes"]],
  ["rename", ["edit", "--index", "0", "--new-title", "Renamed"]],
  ["move", ["edit", "--index", "0", "--row", "4"]],
  ["filter", ["edit", "--index", "0", "--where", "span.op:queue"]],
])("preserves saved pipelines after %s and reload", async (name, args) => {
  const result = await ctx.run([
    "dashboard",
    "widget",
    args[0],
    "test-org/123",
    ...args.slice(1),
    "--json",
  ]);
  expect(result.exitCode, result.stderr).toBe(0);

  const reload = await ctx.run(["api", endpoint]);
  expect(reload.exitCode, reload.stderr).toBe(0);
  const expected = structuredClone(savedDashboard);
  const transformed = expected.widgets![0]!;
  if (name === "rename") {
    transformed.title = "Renamed";
  } else if (name === "move") {
    transformed.layout!.y = 4;
  } else if (name === "filter") {
    transformed.queries![0]!.conditions = "span.op:queue";
  } else if (name === "delete another widget") {
    expected.widgets!.splice(1, 1);
  }
  const reloaded: DashboardDetail = JSON.parse(reload.stdout);
  expect(reloaded).toEqual({
    ...expected,
    widgets:
      name === "add"
        ? [
            ...expected.widgets!,
            expect.objectContaining({ title: "New widget" }),
          ]
        : expected.widgets,
  });
});
