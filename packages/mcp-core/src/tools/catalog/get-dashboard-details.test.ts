import {
  dashboardDetailsFixture,
  dashboardListFixture,
  mswServer,
} from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content";
import getDashboardDetails, {
  getDashboardDetailsOutputSchema,
} from "./get-dashboard-details.js";

function getDashboard(result: unknown) {
  assertStructuredOnlyResult(result);
  const content = getStructuredContent(result);
  const parsed = getDashboardDetailsOutputSchema.parse(content);
  expect(parsed).toEqual(content);
  return parsed.dashboard;
}

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

const projectConstrainedContext = {
  ...context,
  constraints: {
    ...context.constraints,
    projectSlug: "cloudflare-mcp",
  },
};

describe("get_dashboard_details", () => {
  it("returns dashboard details by ID", async () => {
    const result = await getDashboardDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        dashboardIdOrTitle: "101",
      },
      context,
    );

    assertStructuredOnlyResult(result);
    const content = getStructuredContent(result);
    expect(getDashboardDetailsOutputSchema.parse(content)).toEqual(content);
    expect(content).toMatchInlineSnapshot(`
      {
        "dashboard": {
          "createdBy": "Jane Developer",
          "createdByEmail": "jane@example.com",
          "dateCreated": "2025-04-14T10:15:00.000Z",
          "end": null,
          "environments": [
            "production",
          ],
          "expired": false,
          "filters": {
            "globalFilters": [
              {
                "dataset": "error-events",
                "tagKey": "browser.name",
                "value": "browser.name:[Chrome]",
              },
            ],
            "releaseIds": [
              "1234",
            ],
            "releases": [
              "frontend@1.2.3",
            ],
          },
          "id": "101",
          "isFavorited": true,
          "period": "24h",
          "prebuiltId": null,
          "projects": [
            "4509106749636608",
          ],
          "start": null,
          "title": "Errors Overview",
          "url": "https://sentry-mcp-evals.sentry.io/dashboard/101/?project=4509106749636608&statsPeriod=24h",
          "utc": true,
          "widgets": [
            {
              "datasetSource": "discover",
              "description": "Handled errors over time",
              "displayType": "line",
              "id": "201",
              "interval": "5m",
              "layout": {
                "h": 2,
                "w": 6,
                "x": 0,
                "y": 0,
              },
              "limit": null,
              "queries": [
                {
                  "aggregates": [
                    "count()",
                  ],
                  "columns": [],
                  "conditions": "error.handled:true",
                  "fields": [
                    "count()",
                  ],
                  "name": null,
                  "orderby": "-count",
                },
              ],
              "title": "Handled Errors",
              "widgetType": "error-events",
            },
            {
              "datasetSource": "discover",
              "description": null,
              "displayType": "table",
              "id": "202",
              "interval": "5m",
              "layout": {
                "h": 3,
                "w": 6,
                "x": 0,
                "y": 2,
              },
              "limit": 5,
              "queries": [
                {
                  "aggregates": [
                    "count()",
                  ],
                  "columns": [
                    "issue",
                  ],
                  "conditions": "is:unresolved",
                  "fields": [
                    "issue",
                    "count()",
                  ],
                  "name": "Top Issues",
                  "orderby": "-count",
                },
              ],
              "title": "Top Issues",
              "widgetType": "error-events",
            },
          ],
        },
      }
    `);
    const text = JSON.stringify(content);
    // Backend-only fields stay out of the mapped payload.
    for (const leaked of ["permissions", "teamsWithEditAccess"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("resolves an exact dashboard title", async () => {
    const result = await getDashboardDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        dashboardIdOrTitle: "errors overview",
      },
      context,
    );

    expect(getDashboard(result)).toMatchObject({
      id: "101",
      title: "Errors Overview",
    });
  });

  it("resolves dashboard titles after applying the active project constraint", async () => {
    let requestUrl: string | null = null;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/",
        ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json([
            {
              ...dashboardListFixture[0],
              title: "Shared Dashboard",
            },
            {
              ...dashboardListFixture[1],
              title: "Shared Dashboard",
            },
          ]);
        },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/102/",
        () =>
          HttpResponse.json({
            ...dashboardDetailsFixture,
            id: "102",
            title: "Shared Dashboard",
            projects: [],
            widgets: [],
          }),
      ),
    );

    const result = await getDashboardDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        dashboardIdOrTitle: "Shared Dashboard",
      },
      projectConstrainedContext,
    );

    if (!requestUrl) {
      throw new Error("Expected dashboard list request to be captured.");
    }
    expect(new URL(requestUrl).searchParams.has("project")).toBe(false);
    expect(getDashboard(result)).toMatchObject({
      id: "102",
      url: "https://sentry-mcp-evals.sentry.io/dashboard/102/?project=4509109104082945&statsPeriod=24h",
    });
  });

  it("returns a null creator when Sentry has no usable identity", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/101/",
        () => HttpResponse.json({ ...dashboardDetailsFixture, createdBy: {} }),
      ),
    );

    const dashboard = getDashboard(
      await getDashboardDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          dashboardIdOrTitle: "101",
        },
        context,
      ),
    );

    expect(dashboard.createdBy).toBeNull();
    expect(dashboard.createdByEmail).toBeNull();
  });

  it("returns candidates for ambiguous dashboard titles", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/",
        () =>
          HttpResponse.json([
            dashboardListFixture[0],
            {
              ...dashboardListFixture[1],
              title: dashboardListFixture[0].title,
            },
          ]),
      ),
    );

    await expect(
      getDashboardDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          dashboardIdOrTitle: dashboardListFixture[0].title,
        },
        context,
      ),
    ).rejects.toThrow(
      'Multiple dashboards match the title "Errors Overview". Use a dashboard ID instead.',
    );
  });

  it("rejects missing dashboard titles", async () => {
    await expect(
      getDashboardDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          dashboardIdOrTitle: "Missing Dashboard",
        },
        context,
      ),
    ).rejects.toThrow(
      'No dashboard with title "Missing Dashboard" found in "sentry-mcp-evals".',
    );
  });

  it("rejects dashboards outside the active project constraint", async () => {
    const paths: string[] = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
        ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json({
            id: "4509109104082945",
            slug: "cloudflare-mcp",
            name: "cloudflare-mcp",
          });
        },
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/101/",
        ({ request }) => {
          paths.push(new URL(request.url).pathname);
          return HttpResponse.json(dashboardDetailsFixture);
        },
      ),
    );

    await expect(
      getDashboardDetails.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          dashboardIdOrTitle: "101",
        },
        projectConstrainedContext,
      ),
    ).rejects.toThrow(/Dashboard/);
    expect(paths).toEqual([
      "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
      "/api/0/organizations/sentry-mcp-evals/dashboards/101/",
    ]);
  });

  it("accepts dashboard payloads with no widgets", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/101/",
        () =>
          HttpResponse.json({
            ...dashboardDetailsFixture,
            widgets: [],
          }),
      ),
    );

    const result = await getDashboardDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        dashboardIdOrTitle: "101",
      },
      context,
    );

    expect(getDashboard(result).widgets).toEqual([]);
  });

  it("accepts widgets whose display type is null", async () => {
    const [widget] = dashboardDetailsFixture.widgets;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/101/",
        () =>
          HttpResponse.json({
            ...dashboardDetailsFixture,
            widgets: [{ ...widget, displayType: null }],
          }),
      ),
    );

    const result = await getDashboardDetails.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        dashboardIdOrTitle: "101",
      },
      context,
    );

    expect(getDashboard(result).widgets[0]).toMatchObject({
      title: "Handled Errors",
      displayType: null,
    });
  });
});
