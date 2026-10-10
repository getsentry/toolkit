import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import { prepareToolParams } from "../catalog-runtime/availability";
import findProjects, { findProjectsOutputSchema } from "./find-projects.js";

describe("find_projects", () => {
  it("serializes", async () => {
    const context = getServerContext();
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/projects/",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("per_page")).toBe("25");
          return HttpResponse.json([
            {
              id: "1",
              slug: "cloudflare-mcp",
              name: "Cloudflare MCP",
            },
          ]);
        },
      ),
    );

    const params = prepareToolParams({
      tool: findProjects,
      params: {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        query: null,
        cursor: null,
      },
      context,
    }) as Parameters<typeof findProjects.handler>[0];
    const result = await findProjects.handler(params, context);

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(findProjectsOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "hasMore": false,
        "nextCursor": null,
        "projects": [
          {
            "slug": "cloudflare-mcp",
          },
        ],
      }
    `);
  });

  it("preserves search and cursor while returning a page of 25 projects", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/projects/",
        ({ request }) => {
          expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual(
            {
              per_page: "25",
              query: "example",
              cursor: "previous",
            },
          );
          return HttpResponse.json(
            Array.from({ length: 25 }, (_, index) => ({
              id: String(index + 1),
              slug: `project-${String(index + 1).padStart(3, "0")}`,
              name: `Project ${index + 1}`,
            })),
            {
              headers: {
                Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/projects/?cursor=page-2>; rel="next"; results="true"; cursor="page-2"',
              },
            },
          );
        },
      ),
    );

    const result = await findProjects.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        query: "example",
        cursor: "previous",
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    const structuredContent = findProjectsOutputSchema.parse(
      getStructuredContent(result),
    );
    expect(structuredContent.projects).toHaveLength(25);
    expect(structuredContent.projects.at(-1)).toEqual({ slug: "project-025" });
    expect(structuredContent).toMatchObject({
      hasMore: true,
      nextCursor: "page-2",
    });
  });

  it("reports no more results when the next link has results=false", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/projects/",
        ({ request }) => {
          expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual(
            {
              per_page: "25",
              cursor: "page-2",
            },
          );
          return HttpResponse.json(
            [
              {
                id: "26",
                slug: "project-026",
                name: "Project 26",
              },
            ],
            {
              headers: {
                Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/projects/?cursor=page-3>; rel="next"; results="false"; cursor="page-3"',
              },
            },
          );
        },
      ),
    );

    const result = await findProjects.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        query: null,
        cursor: "page-2",
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toEqual({
      projects: [{ slug: "project-026" }],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("preserves mixed-case organization slug in the API path", async () => {
    const context = getServerContext();

    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/*/projects/",
        ({ request }) => {
          expect(new URL(request.url).pathname).toBe(
            "/api/0/organizations/MyOrg/projects/",
          );
          return HttpResponse.json([
            {
              id: "1",
              slug: "MyProject",
              name: "My Project",
            },
          ]);
        },
      ),
    );

    const params = prepareToolParams({
      tool: findProjects,
      params: {
        organizationSlug: " MyOrg ",
        regionUrl: null,
        query: null,
        cursor: null,
      },
      context,
    }) as Parameters<typeof findProjects.handler>[0];

    const result = await findProjects.handler(params, context);

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toEqual({
      projects: [{ slug: "MyProject" }],
      hasMore: false,
      nextCursor: null,
    });
  });
});
