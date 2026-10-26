import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createDashboardFixture } from "./dashboard-fixture";
import fixtureData from "./dashboard-fixture-data.json" with { type: "json" };

type Fixture = Awaited<ReturnType<typeof createDashboardFixture>>;
const active: Fixture[] = [];
const accessToken = "local-test-token";
const dashboardResponse = z
  .object({
    id: z.string(),
    widgets: z.array(
      z
        .object({
          id: z.string(),
          queries: z.array(z.object({ id: z.string() }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

afterEach(async () => {
  await Promise.all(active.splice(0).map((fixture) => fixture.close()));
});

async function fixture() {
  const instance = await createDashboardFixture({ accessToken });
  active.push(instance);
  return instance;
}

function request(fixture: Fixture, path: string, body?: unknown) {
  return fetch(`${fixture.baseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function copyBody(projectId: number, title: string) {
  const source = structuredClone(fixtureData.sourceDashboard);
  return {
    ...source,
    title,
    projects: [projectId],
    environment: ["staging"],
    widgets: source.widgets.map(({ id, ...widget }) => widget),
  };
}

function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      snakeKeys(value),
    ]),
  );
}

describe("dashboard Code Mode eval fixture", () => {
  it("returns dashboard list metadata with accurate widget previews", async () => {
    const instance = await fixture();
    const response = await request(
      instance,
      `/api/0/organizations/${instance.organizationSlug}/dashboards/?query=Errors`,
    );
    expect(response.status).toBe(200);
    const dashboards = z
      .array(z.record(z.string(), z.unknown()))
      .parse(await response.json());
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0]).toMatchObject({
      id: "101",
      title: "Errors Overview",
      widgetDisplay: ["line", "table"],
      widgetPreview: [
        {
          displayType: "line",
          layout: { x: 0, y: 0, w: 6, h: 2 },
        },
        {
          displayType: "table",
          layout: { x: 0, y: 2, w: 6, h: 3 },
        },
      ],
      projects: [101, 102],
      environment: ["production"],
    });
    expect(dashboards[0]).not.toHaveProperty("widgets");
  });

  it("persists copies made through the HTTP API using both supported key styles", async () => {
    const instance = await fixture();
    const path = `/api/0/organizations/${instance.organizationSlug}/dashboards/`;
    const original = dashboardResponse.parse(
      await (await request(instance, `${path}101/`)).json(),
    );
    expect(original.widgets).toHaveLength(2);

    const firstResponse = await request(
      instance,
      path,
      copyBody(101, "Frontend staging"),
    );
    expect(firstResponse.status).toBe(201);
    const first = dashboardResponse.parse(await firstResponse.json());
    const secondResponse = await request(
      instance,
      path,
      snakeKeys(copyBody(102, "Backend staging")),
    );
    expect(secondResponse.status).toBe(201);
    const second = dashboardResponse.parse(await secondResponse.json());

    expect((await request(instance, `${path}${first.id}/`)).status).toBe(200);
    expect(first.widgets[0].id).not.toBe(original.widgets[0].id);
    expect(first.widgets[0].queries[0].id).not.toBe(
      original.widgets[0].queries[0].id,
    );
    expect(await (await request(instance, `${path}101/`)).json()).toEqual(
      original,
    );
    expect(
      instance.verify(
        [
          `ID ${first.id}: https://${instance.organizationSlug}.sentry.io/dashboard/${first.id}/`,
          `ID ${second.id}: https://sentry.io/organizations/${instance.organizationSlug}/dashboard/${second.id}/`,
        ].join("\n"),
      ),
    ).toEqual({ success: true, dashboardIds: ["201", "202"] });

    const discovery = await (await fetch(instance.openapiUrl)).json();
    expect(discovery).toMatchObject({
      paths: {
        "/api/0/organizations/{organization_id_or_slug}/dashboards/": {
          post: { requestBody: expect.any(Object) },
        },
        "/api/0/organizations/{organization_id_or_slug}/dashboards/{dashboard_id}/":
          {
            get: { responses: { "200": expect.any(Object) } },
          },
      },
    });
    expect((await request(instance, "/snapshot")).status).toBe(404);

    instance.reset();
    expect(instance.snapshot().dashboards).toHaveLength(1);
    expect(instance.snapshot().requests).toEqual([]);
  });

  it("rejects missing authentication, foreign widget IDs and inaccessible projects without writing", async () => {
    const instance = await fixture();
    const path = `/api/0/organizations/${instance.organizationSlug}/dashboards/`;
    expect(
      (
        await fetch(`${instance.baseUrl}${path}`, {
          method: "POST",
          body: JSON.stringify(copyBody(101, "Frontend staging")),
        })
      ).status,
    ).toBe(401);
    const copiedIds = await request(
      instance,
      path,
      fixtureData.sourceDashboard,
    );
    expect(copiedIds.status).toBe(400);
    expect(await copiedIds.json()).toEqual({
      detail: "You cannot update widgets that are not part of this dashboard.",
    });
    expect(
      (await request(instance, path, copyBody(999, "Unavailable project")))
        .status,
    ).toBe(400);
    expect(instance.snapshot().dashboards).toHaveLength(1);
  });

  it("grades actual state, rejecting claims of success, lost queries and duplicate writes", async () => {
    const instance = await fixture();
    const path = `/api/0/organizations/${instance.organizationSlug}/dashboards/`;
    const answer = [201, 202]
      .map(
        (id) =>
          `https://${instance.organizationSlug}.sentry.io/dashboard/${id}/`,
      )
      .join("\n");
    expect(() => instance.verify(answer)).toThrow(
      "Expected exactly two new dashboards",
    );

    const brokenCopy = copyBody(101, "Frontend staging");
    brokenCopy.widgets[0].queries[0].conditions = "";
    expect((await request(instance, path, brokenCopy)).status).toBe(201);
    expect(
      (await request(instance, path, copyBody(102, "Backend staging"))).status,
    ).toBe(201);
    expect(() => instance.verify(answer)).toThrow(
      "widget configuration differs",
    );

    instance.reset();
    for (const [project, title] of [
      [101, "Frontend staging"],
      [102, "Backend staging"],
    ] as const) {
      expect(
        (await request(instance, path, copyBody(project, title))).status,
      ).toBe(201);
    }
    expect(() =>
      instance.verify("Created both dashboards successfully"),
    ).toThrow("final answer omits");
    expect(instance.verify(answer).success).toBe(true);
    expect(
      (await request(instance, path, copyBody(101, "Frontend staging"))).status,
    ).toBe(201);
    expect(() => instance.verify(answer)).toThrow(
      "Expected exactly two new dashboards",
    );
  });
});
