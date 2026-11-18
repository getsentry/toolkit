import { dashboardListFixture, mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { assert, describe, expect, it } from "vitest";
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
    let requestUrl: string | undefined;
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

  /** One dashboards list page, with a `Link` next cursor when given. */
  function dashboardPage(
    dashboards: Array<{ id: string; title: string; projects: number[] }>,
    nextCursor?: string,
  ) {
    return HttpResponse.json(
      dashboards.map((dashboard, index) => ({
        ...dashboardListFixture[index % dashboardListFixture.length],
        ...dashboard,
      })),
      nextCursor
        ? {
            headers: {
              Link: `<https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/?cursor=${nextCursor}>; rel="next"; results="true"; cursor="${nextCursor}"`,
            },
          }
        : undefined,
    );
  }

  const CLOUDFLARE_PROJECT_ID = 4509109104082945;

  /** Serves the scoped project and the dashboard pages keyed by cursor. */
  function useProjectDashboardPages(
    pages: Record<string, Response>,
    requestUrls: string[],
  ) {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/",
        () =>
          HttpResponse.json({
            id: String(CLOUDFLARE_PROJECT_ID),
            slug: "cloudflare-mcp",
            name: "cloudflare-mcp",
          }),
      ),
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/dashboards/",
        ({ request }) => {
          requestUrls.push(request.url);
          const cursor = new URL(request.url).searchParams.get("cursor");
          return pages[cursor ?? "first"]!.clone();
        },
      ),
    );
  }

  it("fetches additional pages to fill project-constrained dashboard results", async () => {
    const requestUrls: string[] = [];
    useProjectDashboardPages(
      {
        first: dashboardPage(
          [
            { id: "201", title: "Other Project Errors", projects: [1] },
            { id: "202", title: "Other Project Metrics", projects: [2] },
          ],
          "2:1:0",
        ),
        "2:1:0": dashboardPage(
          [
            {
              id: "203",
              title: "Cloudflare Errors",
              projects: [CLOUDFLARE_PROJECT_ID],
            },
            {
              id: "204",
              title: "Cloudflare Metrics",
              projects: [CLOUDFLARE_PROJECT_ID],
            },
          ],
          "2:2:0",
        ),
      },
      requestUrls,
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
    const [firstUrl, secondUrl] = requestUrls;
    assert(firstUrl && secondUrl, "Expected two dashboard list requests");
    expect(new URL(firstUrl).searchParams.get("per_page")).toBe("2");
    expect(new URL(secondUrl).searchParams.get("cursor")).toBe("2:1:0");
    expect(new URL(secondUrl).searchParams.get("per_page")).toBe("2");
    assertStructuredOnlyResult(result);
    const structuredContent = findDashboardsOutputSchema.parse(
      getStructuredContent(result),
    );
    expect(structuredContent.dashboards.map(({ id }) => id)).toEqual([
      "203",
      "204",
    ]);
    expect(structuredContent.nextCursor).toBe("2:2:0");
  });

  it("resumes inside a filtered page without repeating or skipping dashboards", async () => {
    const requestUrls: string[] = [];
    useProjectDashboardPages(
      {
        first: dashboardPage(
          [
            {
              id: "301",
              title: "Cloudflare Errors",
              projects: [CLOUDFLARE_PROJECT_ID],
            },
            { id: "302", title: "Other Project Metrics", projects: [2] },
          ],
          "2:1:0",
        ),
        "2:1:0": dashboardPage(
          [
            {
              id: "303",
              title: "Cloudflare Metrics",
              projects: [CLOUDFLARE_PROJECT_ID],
            },
            {
              id: "304",
              title: "Cloudflare Throughput",
              projects: [CLOUDFLARE_PROJECT_ID],
            },
          ],
          "2:2:0",
        ),
      },
      requestUrls,
    );
    const search = (cursor: string | null, limit: number) =>
      findDashboards.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          titleQuery: null,
          sort: "title",
          cursor,
          limit,
        },
        projectConstrainedContext,
      );

    const firstResult = await search(null, 2);
    assertStructuredOnlyResult(firstResult);
    const first = findDashboardsOutputSchema.parse(
      getStructuredContent(firstResult),
    );
    expect(first.dashboards.map(({ id }) => id)).toEqual(["301", "303"]);
    // The walk stopped after one of page 2's visible dashboards.
    expect(first.nextCursor).toBe("2:1:0_0");

    const secondResult = await search(first.nextCursor, 1);

    const thirdUrl = requestUrls[2];
    assert(thirdUrl, "Expected a third dashboard list request");
    expect(new URL(thirdUrl).searchParams.get("cursor")).toBe("2:1:0");
    expect(new URL(thirdUrl).searchParams.get("per_page")).toBe("2");
    assertStructuredOnlyResult(secondResult);
    expect(getStructuredContent(secondResult)).toMatchObject({
      dashboards: [{ id: "304", title: "Cloudflare Throughput" }],
      nextCursor: "2:2:0",
    });
  });

  it("resumes a cursor within the first API page", async () => {
    const requestUrls: string[] = [];
    useProjectDashboardPages(
      {
        first: dashboardPage([
          {
            id: "401",
            title: "Cloudflare Errors",
            projects: [CLOUDFLARE_PROJECT_ID],
          },
          {
            id: "402",
            title: "Cloudflare Metrics",
            projects: [CLOUDFLARE_PROJECT_ID],
          },
        ]),
      },
      requestUrls,
    );

    const result = await findDashboards.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        titleQuery: null,
        sort: "title",
        // The cursor after one row of the first page.
        cursor: "0:0:0_0",
        limit: 1,
      },
      projectConstrainedContext,
    );

    const searchParams = new URL(requestUrls[0]!).searchParams;
    expect(searchParams.has("cursor")).toBe(false);
    expect(searchParams.get("per_page")).toBe("2");
    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toMatchObject({
      dashboards: [{ id: "402", title: "Cloudflare Metrics" }],
      nextCursor: null,
    });
  });

  it("passes search, sort, cursor, and limit query parameters", async () => {
    let requestUrl: string | undefined;
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
    expect(structuredContent["dashboards"]).toMatchObject([
      { widgetCount: 3, widgetTypes: ["line"] },
    ]);
  });
});
