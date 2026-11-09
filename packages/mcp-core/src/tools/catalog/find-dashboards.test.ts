import { dashboardListFixture, mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import findDashboards, {
  findDashboardsOutputSchema,
} from "./find-dashboards.js";

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

describe("find_dashboards", () => {
  it("lists dashboards with a pagination cursor", async () => {
    const result = await findDashboards.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        titleQuery: null,
        sort: "title",
        cursor: null,
        limit: 1,
      },
      context,
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(findDashboards.outputSchema).toBe(findDashboardsOutputSchema);
    expect(findDashboardsOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "dashboards": [
          {
            "createdBy": "Jane Developer",
            "dateCreated": "2025-04-14T10:15:00.000Z",
            "environments": [
              "production",
            ],
            "id": "101",
            "isFavorited": true,
            "lastVisited": "2025-04-15T12:00:00.000Z",
            "prebuiltId": null,
            "projects": [
              "4509106749636608",
            ],
            "title": "Errors Overview",
            "url": "https://sentry-mcp-evals.sentry.io/dashboard/101/?project=4509106749636608",
            "widgetCount": 2,
            "widgetTypes": [
              "line",
              "table",
            ],
          },
        ],
        "nextCursor": "dashboard-cursor",
      }
    `);
  });

  it("shows an empty title search", async () => {
    const result = await findDashboards.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        titleQuery: "missing",
        sort: "title",
        cursor: null,
        limit: 10,
      },
      context,
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toEqual({
      dashboards: [],
      nextCursor: null,
    });
  });

  it("filters explicit dashboard project IDs in project-constrained sessions", async () => {
    let requestUrl: string | null = null;
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
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/",
        ({ request }) => {
          paths.push(new URL(request.url).pathname);
          requestUrl = request.url;
          return HttpResponse.json(dashboardListFixture);
        },
      ),
    );

    const result = await findDashboards.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        titleQuery: null,
        sort: "title",
        cursor: null,
        limit: 10,
      },
      projectConstrainedContext,
    );

    if (!requestUrl) {
      throw new Error("Expected dashboard list request to be captured.");
    }
    const searchParams = new URL(requestUrl).searchParams;
    expect(searchParams.has("project")).toBe(false);
    expect(paths).toEqual([
      "/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
      "/api/0/organizations/sentry-mcp-evals/dashboards/",
    ]);
    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchObject({
      dashboards: [
        {
          id: "102",
          title: "Errors Overview Copy",
          projects: [],
          url: "https://sentry-mcp-evals.sentry.io/dashboard/102/?project=4509109104082945",
        },
      ],
    });
  });

  it("fetches additional pages to fill project-constrained dashboard results", async () => {
    const requestUrls: string[] = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
        () =>
          HttpResponse.json({
            id: "4509109104082945",
            slug: "cloudflare-mcp",
            name: "cloudflare-mcp",
          }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/",
        ({ request }) => {
          requestUrls.push(request.url);
          const cursor = new URL(request.url).searchParams.get("cursor");
          if (!cursor) {
            return HttpResponse.json(
              [
                {
                  ...dashboardListFixture[0],
                  id: "201",
                  title: "Other Project Errors",
                  projects: [1],
                },
                {
                  ...dashboardListFixture[1],
                  id: "202",
                  title: "Other Project Metrics",
                  projects: [2],
                },
              ],
              {
                headers: {
                  Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/?cursor=page-2>; rel="next"; results="true"; cursor="page-2"',
                },
              },
            );
          }

          return HttpResponse.json(
            [
              {
                ...dashboardListFixture[0],
                id: "203",
                title: "Cloudflare Errors",
                projects: [4509109104082945],
              },
              {
                ...dashboardListFixture[1],
                id: "204",
                title: "Cloudflare Metrics",
                projects: [4509109104082945],
              },
            ],
            {
              headers: {
                Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/?cursor=page-3>; rel="next"; results="true"; cursor="page-3"',
              },
            },
          );
        },
      ),
    );

    const result = await findDashboards.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        titleQuery: null,
        sort: "title",
        cursor: null,
        limit: 2,
      },
      projectConstrainedContext,
    );

    expect(requestUrls).toHaveLength(2);
    expect(new URL(requestUrls[0]!).searchParams.get("per_page")).toBe("2");
    expect(new URL(requestUrls[1]!).searchParams.get("cursor")).toBe("page-2");
    expect(new URL(requestUrls[1]!).searchParams.get("per_page")).toBe("2");
    assertStructuredOnlyResult(result);
    const structuredContent = findDashboardsOutputSchema.parse(
      getStructuredContent(result),
    );
    expect(structuredContent.dashboards.map(({ id }) => id)).toEqual([
      "203",
      "204",
    ]);
    expect(structuredContent.nextCursor).toEqual(
      expect.stringContaining("mcp-dashboard-project:"),
    );
  });

  it("uses a project cursor when a filtered page has more visible dashboards than requested", async () => {
    const requestUrls: string[] = [];
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
        () =>
          HttpResponse.json({
            id: "4509109104082945",
            slug: "cloudflare-mcp",
            name: "cloudflare-mcp",
          }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/",
        ({ request }) => {
          requestUrls.push(request.url);
          const cursor = new URL(request.url).searchParams.get("cursor");
          if (!cursor) {
            return HttpResponse.json(
              [
                {
                  ...dashboardListFixture[0],
                  id: "301",
                  title: "Cloudflare Errors",
                  projects: [4509109104082945],
                },
                {
                  ...dashboardListFixture[1],
                  id: "302",
                  title: "Other Project Metrics",
                  projects: [2],
                },
              ],
              {
                headers: {
                  Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/?cursor=page-2>; rel="next"; results="true"; cursor="page-2"',
                },
              },
            );
          }

          if (cursor === "page-2") {
            return HttpResponse.json(
              [
                {
                  ...dashboardListFixture[0],
                  id: "303",
                  title: "Cloudflare Metrics",
                  projects: [4509109104082945],
                },
                {
                  ...dashboardListFixture[1],
                  id: "304",
                  title: "Cloudflare Throughput",
                  projects: [4509109104082945],
                },
              ],
              {
                headers: {
                  Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/?cursor=page-3>; rel="next"; results="true"; cursor="page-3"',
                },
              },
            );
          }

          return HttpResponse.json([
            {
              ...dashboardListFixture[0],
              id: "305",
              title: "Cloudflare Latency",
              projects: [4509109104082945],
            },
          ]);
        },
      ),
    );

    const firstResult = await findDashboards.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        titleQuery: null,
        sort: "title",
        cursor: null,
        limit: 2,
      },
      projectConstrainedContext,
    );
    assertStructuredOnlyResult(firstResult);
    const firstStructuredContent = findDashboardsOutputSchema.parse(
      getStructuredContent(firstResult),
    );
    const nextCursor = firstStructuredContent.nextCursor;

    expect(nextCursor).toEqual(
      expect.stringContaining("mcp-dashboard-project:"),
    );
    expect(firstStructuredContent.dashboards.map(({ id }) => id)).toEqual([
      "301",
      "303",
    ]);

    const secondResult = await findDashboards.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        titleQuery: null,
        sort: "title",
        cursor: nextCursor!,
        limit: 1,
      },
      projectConstrainedContext,
    );

    expect(new URL(requestUrls[2]!).searchParams.get("cursor")).toBe("page-2");
    expect(new URL(requestUrls[2]!).searchParams.get("per_page")).toBe("2");
    assertStructuredOnlyResult(secondResult);
    expect(getStructuredContent(secondResult)).toMatchObject({
      dashboards: [{ id: "304", title: "Cloudflare Throughput" }],
    });
  });

  it("resumes a project cursor within the first API page", async () => {
    let requestUrl: string | null = null;
    const firstPageCursor = `mcp-dashboard-project:${Buffer.from(
      JSON.stringify({
        v: 1,
        apiCursor: null,
        offset: 1,
        pageLimit: 2,
      }),
    ).toString("base64url")}`;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
        () =>
          HttpResponse.json({
            id: "4509109104082945",
            slug: "cloudflare-mcp",
            name: "cloudflare-mcp",
          }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/",
        ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json([
            {
              ...dashboardListFixture[0],
              id: "401",
              title: "Cloudflare Errors",
              projects: [4509109104082945],
            },
            {
              ...dashboardListFixture[1],
              id: "402",
              title: "Cloudflare Metrics",
              projects: [4509109104082945],
            },
          ]);
        },
      ),
    );

    const result = await findDashboards.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        titleQuery: null,
        sort: "title",
        cursor: firstPageCursor,
        limit: 1,
      },
      projectConstrainedContext,
    );

    if (!requestUrl) {
      throw new Error("Expected dashboard list request to be captured.");
    }
    const searchParams = new URL(requestUrl).searchParams;
    expect(searchParams.has("cursor")).toBe(false);
    expect(searchParams.get("per_page")).toBe("2");
    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchObject({
      dashboards: [{ id: "402", title: "Cloudflare Metrics" }],
    });
  });

  it("rejects project cursors in org-wide searches before calling Sentry", async () => {
    let rejectPhase = false;
    let orgWideDashboardRequests = 0;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
        () =>
          HttpResponse.json({
            id: "4509109104082945",
            slug: "cloudflare-mcp",
            name: "cloudflare-mcp",
          }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/",
        () => {
          if (rejectPhase) {
            orgWideDashboardRequests++;
          }
          return HttpResponse.json([
            {
              ...dashboardListFixture[0],
              id: "501",
              title: "Cloudflare Errors",
              projects: [4509109104082945],
            },
            {
              ...dashboardListFixture[1],
              id: "502",
              title: "Cloudflare Metrics",
              projects: [4509109104082945],
            },
          ]);
        },
      ),
    );

    const projectResult = await findDashboards.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        titleQuery: null,
        sort: "title",
        cursor: null,
        limit: 1,
      },
      projectConstrainedContext,
    );
    assertStructuredOnlyResult(projectResult);
    const projectCursor = findDashboardsOutputSchema.parse(
      getStructuredContent(projectResult),
    ).nextCursor;
    expect(projectCursor).toEqual(
      expect.stringContaining("mcp-dashboard-project:"),
    );
    if (!projectCursor) {
      throw new Error("Expected project-scoped dashboard cursor.");
    }

    rejectPhase = true;
    await expect(
      findDashboards.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          titleQuery: null,
          sort: "title",
          cursor: projectCursor,
          limit: 1,
        },
        context,
      ),
    ).rejects.toThrow("Project-scoped dashboard cursors");
    expect(orgWideDashboardRequests).toBe(0);
  });

  it("passes search, sort, cursor, and limit query parameters", async () => {
    let requestUrl: string | null = null;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/",
        ({ request }) => {
          requestUrl = request.url;
          return HttpResponse.json(dashboardListFixture);
        },
      ),
    );

    await findDashboards.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        titleQuery: "errors",
        sort: "-dateCreated",
        cursor: "dashboard-cursor",
        limit: 25,
      },
      context,
    );

    if (!requestUrl) {
      throw new Error("Expected dashboard list request to be captured.");
    }
    const searchParams = new URL(requestUrl).searchParams;
    expect(searchParams.get("query")).toBe("errors");
    expect(searchParams.get("sort")).toBe("-dateCreated");
    expect(searchParams.get("cursor")).toBe("dashboard-cursor");
    expect(searchParams.get("per_page")).toBe("25");
  });

  it("leaves null widget display types out of widgetTypes", async () => {
    const [dashboard] = dashboardListFixture;
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/",
        () =>
          HttpResponse.json([
            {
              ...dashboard,
              widgetDisplay: ["line", null, "line"],
              widgetPreview: [
                { displayType: "line", layout: null },
                { displayType: null, layout: null },
                { displayType: "line", layout: null },
              ],
            },
          ]),
      ),
    );

    const result = await findDashboards.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        titleQuery: null,
        sort: "title",
        cursor: null,
        limit: 25,
      },
      context,
    );

    const structuredContent = getStructuredContent(result);
    expect(findDashboardsOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent.dashboards).toMatchObject([
      { widgetCount: 3, widgetTypes: ["line"] },
    ]);
  });
});
