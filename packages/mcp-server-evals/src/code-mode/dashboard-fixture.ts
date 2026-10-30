import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { z } from "zod";
import fixtureData from "./dashboard-fixture-data.json" with { type: "json" };

const ORGANIZATION = "dashboard-evals";
const TARGETS = [
  { projectId: 101, title: "Frontend staging" },
  { projectId: 102, title: "Backend staging" },
] as const;
const DATE_CREATED = "2026-10-25T10:00:00.000Z";

const querySchema = z.object({
  fields: z.array(z.string()),
  conditions: z.string(),
  name: z.string().default(""),
  aggregates: z.array(z.string()).nullable().default(null),
  columns: z.array(z.string()).nullable().default(null),
  fieldAliases: z.array(z.string()).nullable().default(null),
  orderby: z.string().default(""),
  isHidden: z.boolean().default(false),
  selectedAggregate: z.number().int().nullable().default(null),
  linkedDashboards: z.array(z.unknown()).default([]),
});

const layoutSchema = z
  .object({
    x: z.number().int().min(0).max(5),
    y: z.number().int().min(0),
    w: z.number().int().min(1).max(6),
    h: z.number().int().min(2),
  })
  .refine((layout) => layout.x + layout.w <= 6, "x + w must not exceed 6");

const widgetSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1).max(255),
  description: z.string().nullable().default(null),
  // This fixture only emulates the two display types present in its source.
  displayType: z.enum(["line", "table"]),
  widgetType: z.enum(["error-events"]).default("error-events"),
  interval: z.string().max(10).default("5m"),
  queries: z.array(querySchema).min(1),
  layout: layoutSchema.nullable().default(null),
  thresholds: z.record(z.string(), z.unknown()).nullable().default(null),
  limit: z.number().int().min(1).nullable().default(null),
  axisRange: z.enum(["auto", "dataMin"]).nullable().default(null),
  legendType: z.enum(["default", "table"]).nullable().default(null),
  datasetSource: z.enum(["user"]).default("user"),
});

const dashboardSchema = z.object({
  title: z.string().trim().min(1).max(255),
  widgets: z.array(widgetSchema).default([]),
  projects: z.array(z.coerce.number().int()).default([]),
  environment: z.array(z.string()).nullable().default(null),
  period: z.string().nullable().default(null),
  filters: z.record(z.string(), z.unknown()).default({}),
  utc: z.boolean().default(false),
  isFavorited: z.boolean().default(false),
  permissions: z
    .object({
      isEditableByEveryone: z.boolean(),
      teamsWithEditAccess: z.array(z.number()),
    })
    .nullable()
    .default(null),
});

type Dashboard = Omit<z.infer<typeof dashboardSchema>, "widgets"> & {
  id: string;
  dateCreated: string;
  createdBy: { id: string; name: string; email: string };
  widgets: Array<
    Omit<z.infer<typeof widgetSchema>, "id" | "queries"> & {
      id: string;
      dashboardId: string;
      dateCreated: string;
      queries: Array<
        z.infer<typeof querySchema> & {
          id: string;
          widgetId: string;
          onDemand: unknown[];
        }
      >;
    }
  >;
  prebuiltId: null;
};

export interface DashboardFixtureSnapshot {
  dashboards: Dashboard[];
  requests: Array<{ method: string; path: string; status: number }>;
}

class FixtureInputError extends Error {}

// Mirror CamelSnakeSerializer's recursive aliases and collision detection.
// Unknown fields are subsequently stripped by the fixture's input schemas.
function camelKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const converted = key.replace(/_([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    if (Object.hasOwn(result, converted)) {
      throw new FixtureInputError(`${key} collides with ${converted}`);
    }
    result[converted] = camelKeys(item);
  }
  return result;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 256_000)
      throw new FixtureInputError("Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new FixtureInputError("Invalid JSON request body");
  }
}

function sourceDashboard(): Dashboard {
  const source = fixtureData.sourceDashboard;
  const parsed = dashboardSchema.parse(source);
  return {
    ...parsed,
    id: source.id,
    dateCreated: source.dateCreated,
    createdBy: structuredClone(source.createdBy),
    prebuiltId: null,
    widgets: parsed.widgets.map((widget, index) => ({
      ...widget,
      id: source.widgets[index].id,
      dashboardId: source.id,
      dateCreated: source.widgets[index].dateCreated,
      layout: widget.layout ? { ...widget.layout, minH: 2 } : null,
      queries: widget.queries.map((query, queryIndex) => ({
        ...query,
        id: source.widgets[index].queries[queryIndex].id,
        widgetId: source.widgets[index].id,
        onDemand: [],
      })),
    })),
  };
}

function widgetSemantics(dashboard: Dashboard) {
  return dashboard.widgets.map(
    ({ id, dashboardId, dateCreated, queries, ...widget }) => ({
      ...widget,
      queries: queries.map(({ id, widgetId, onDemand, ...query }) => query),
    }),
  );
}

/**
 * Local stateful API substitute, not a full Sentry emulator. Its dashboard
 * creation, IDs and aliases follow backend c4b7b5f; the complete three-operation
 * OpenAPI slice is captured from sentry-api-schema 803d6de. It deliberately does
 * not implement query-language validation, quotas, feature flags or real auth.
 * Administrative state is only exposed to the runner, never as HTTP endpoints.
 */
export async function createDashboardFixture({
  accessToken = "code-mode-eval-token",
}: {
  accessToken?: string;
} = {}) {
  const original = sourceDashboard();
  let dashboards = new Map([[original.id, structuredClone(original)]]);
  let nextId = 201;
  let requests: DashboardFixtureSnapshot["requests"] = [];
  const collectionPath = `/api/0/organizations/${ORGANIZATION}/dashboards/`;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const reply = (status: number, body: unknown) => {
      requests.push({ method, path: url.pathname, status });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    try {
      if (method === "GET" && url.pathname === "/openapi.json") {
        reply(200, fixtureData.openapi);
        return;
      }
      if (request.headers.authorization !== `Bearer ${accessToken}`) {
        reply(401, { detail: "Invalid token" });
        return;
      }
      if (url.pathname === collectionPath && method === "GET") {
        const query = url.searchParams.get("query")?.toLowerCase() ?? "";
        reply(
          200,
          [...dashboards.values()]
            .filter((dashboard) =>
              dashboard.title.toLowerCase().includes(query),
            )
            .map((dashboard) => ({
              id: dashboard.id,
              title: dashboard.title,
              dateCreated: dashboard.dateCreated,
              createdBy: dashboard.createdBy,
              environment: dashboard.environment,
              filters: dashboard.filters,
              lastVisited: null,
              widgetDisplay: dashboard.widgets.map(
                (widget) => widget.displayType,
              ),
              widgetPreview: dashboard.widgets.map(
                ({ displayType, layout }) => ({ displayType, layout }),
              ),
              permissions: dashboard.permissions,
              isFavorited: dashboard.isFavorited,
              projects: dashboard.projects,
              prebuiltId: dashboard.prebuiltId,
            })),
        );
        return;
      }
      if (url.pathname === collectionPath && method === "POST") {
        const input = dashboardSchema.parse(camelKeys(await readJson(request)));
        if (
          input.projects.some((id) => !TARGETS.some((t) => t.projectId === id))
        ) {
          reply(400, { projects: ["Invalid project IDs"] });
          return;
        }
        // Backend update_widgets rejects IDs belonging to the original dashboard.
        // Query IDs are ignored during create_widget; new query IDs are allocated.
        if (input.widgets.some((widget) => widget.id)) {
          reply(400, {
            detail:
              "You cannot update widgets that are not part of this dashboard.",
          });
          return;
        }
        if (url.searchParams.has("validateOnly")) {
          reply(200, null);
          return;
        }
        const id = String(nextId++);
        const existingTitles = new Set(
          [...dashboards.values()].map((dashboard) => dashboard.title),
        );
        let title = input.title;
        for (let suffix = 1; existingTitles.has(title); suffix++) {
          title = `${input.title} (${suffix})`;
        }
        const created: Dashboard = {
          ...input,
          title,
          id,
          dateCreated: DATE_CREATED,
          createdBy: structuredClone(original.createdBy),
          prebuiltId: null,
          widgets: input.widgets.map((widget, index) => {
            const widgetId = `${id}${index + 1}`;
            return {
              ...widget,
              id: widgetId,
              dashboardId: id,
              dateCreated: DATE_CREATED,
              layout: widget.layout ? { ...widget.layout, minH: 2 } : null,
              queries: widget.queries.map((query, queryIndex) => ({
                ...query,
                id: `${widgetId}${queryIndex + 1}`,
                widgetId,
                onDemand: [],
              })),
            };
          }),
        };
        dashboards.set(id, created);
        reply(201, created);
        return;
      }
      if (method === "GET" && url.pathname.startsWith(collectionPath)) {
        const id = url.pathname.slice(collectionPath.length).replace(/\/$/, "");
        const dashboard = dashboards.get(id);
        reply(dashboard ? 200 : 404, dashboard ?? { detail: "Not found" });
        return;
      }
      reply(404, { detail: "Not found in the dashboard eval fixture" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        reply(400, { detail: "Invalid dashboard", errors: error.issues });
      } else if (error instanceof FixtureInputError) {
        reply(400, { detail: error.message });
      } else {
        reply(500, { detail: "Fixture internal error" });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const prompt = [
    `In organization ${ORGANIZATION}, copy dashboard ${original.id} (${original.title}) into exactly two new dashboards.`,
    `The original is https://${ORGANIZATION}.sentry.io/dashboard/${original.id}/.`,
    ...TARGETS.map(
      (target) =>
        `Create "${target.title}" with only project ID ${target.projectId} saved in the dashboard.`,
    ),
    'Save only the environment "staging" in each copy.',
    "Preserve the original widgets, their queries, order and layout, and the other saved dashboard filters and time range.",
    "Leave the original dashboard unchanged. Return the IDs and Sentry dashboard links for the two new dashboards.",
  ].join("\n");

  return {
    baseUrl,
    openapiUrl: `${baseUrl}/openapi.json`,
    organizationSlug: ORGANIZATION,
    projectIds: TARGETS.map((target) => target.projectId),
    prompt,
    snapshot(): DashboardFixtureSnapshot {
      return structuredClone({
        dashboards: [...dashboards.values()],
        requests,
      });
    },
    reset() {
      dashboards = new Map([[original.id, structuredClone(original)]]);
      nextId = 201;
      requests = [];
    },
    verify(resultText: string) {
      assert.deepEqual(
        dashboards.get(original.id),
        original,
        "Original dashboard changed",
      );
      const copies = [...dashboards.values()].filter(
        (item) => item.id !== original.id,
      );
      assert.equal(copies.length, 2, "Expected exactly two new dashboards");
      for (const target of TARGETS) {
        const copy = copies.find((item) => item.title === target.title);
        assert(copy, `Missing dashboard: ${target.title}`);
        assert.deepEqual(
          copy.projects,
          [target.projectId],
          `${target.title}: projects differ`,
        );
        assert.deepEqual(
          copy.environment,
          ["staging"],
          `${target.title}: environment differs`,
        );
        assert.deepEqual(
          widgetSemantics(copy),
          widgetSemantics(original),
          `${target.title}: widget configuration differs`,
        );
        assert.deepEqual(
          copy.filters,
          original.filters,
          `${target.title}: filters differ`,
        );
        assert.equal(
          copy.period,
          original.period,
          `${target.title}: time range differs`,
        );
        assert.equal(
          copy.utc,
          original.utc,
          `${target.title}: UTC setting differs`,
        );
        const urls = resultText.match(/https:\/\/[^\s<>"'`\])]+/g) ?? [];
        assert(
          urls.some((value) => {
            const url = new URL(value);
            return (
              (url.hostname === `${ORGANIZATION}.sentry.io` &&
                url.pathname === `/dashboard/${copy.id}/`) ||
              (url.hostname === "sentry.io" &&
                url.pathname ===
                  `/organizations/${ORGANIZATION}/dashboard/${copy.id}/`)
            );
          }),
          `${target.title}: final answer omits its actual dashboard link and ID`,
        );
      }
      return {
        success: true as const,
        dashboardIds: copies.map((copy) => copy.id),
      };
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
