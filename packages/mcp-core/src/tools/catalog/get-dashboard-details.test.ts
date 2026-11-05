import {
  dashboardDetailsFixture,
  dashboardListFixture,
  mswServer,
} from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import getDashboardDetails from "./get-dashboard-details.js";

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

    expect(result).toMatchInlineSnapshot(`
      "# Dashboard Errors Overview in **sentry-mcp-evals**

      **ID**: 101
      **URL**: [Open Dashboard](https://sentry-mcp-evals.sentry.io/dashboard/101/?project=4509106749636608&statsPeriod=24h)
      **Created**: 2025-04-14T10:15:00.000Z
      **Created By**: Jane Developer
      **Projects**: 4509106749636608
      **Environments**: production
      **Period**: 24h
      **UTC**: true
      **Expired**: false
      **Favorited**: yes

      ## Filters

      - **release**: ["frontend@1.2.3"]
      - **globalFilter**: [{"key":"browser.name","value":"Chrome"}]

      ## Widgets

      ### 1. Handled Errors

      **ID**: 201
      **Display Type**: line
      **Widget Type**: error-events
      **Dataset**: discover
      **Interval**: 5m
      **Layout**: x=0, y=0, w=6, h=2
      **Description**: Handled errors over time

      #### Queries

      - **Query**
        - Conditions: \`error.handled:true\`
        - Fields: count()
        - Aggregates: count()
        - Sort: \`-count\`

      ### 2. Top Issues

      **ID**: 202
      **Display Type**: table
      **Widget Type**: error-events
      **Dataset**: discover
      **Interval**: 5m
      **Limit**: 5
      **Layout**: x=0, y=2, w=6, h=3

      #### Queries

      - **Top Issues**
        - Conditions: \`is:unresolved\`
        - Fields: issue, count()
        - Aggregates: count()
        - Columns: issue
        - Sort: \`-count\`

      ## Response Notes

      - Dashboard widgets include saved query definitions, not live query results."
    `);
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

    expect(result).toContain(
      "# Dashboard Errors Overview in **sentry-mcp-evals**",
    );
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
    expect(result).toContain("**ID**: 102");
    expect(result).toContain(
      "https://sentry-mcp-evals.sentry.io/dashboard/102/?project=4509109104082945&statsPeriod=24h",
    );
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

    expect(result).toContain("No widgets found.");
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

    expect(result).toContain("### 1. Handled Errors");
    expect(result).not.toContain("**Display Type**");
  });
});
