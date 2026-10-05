import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { getServerContext } from "../../test-setup.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import { prepareToolParams } from "../catalog-runtime/availability";
import findTeams, { findTeamsOutputSchema } from "./find-teams.js";

describe("find_teams", () => {
  it("serializes", async () => {
    const context = getServerContext();
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/teams/",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("per_page")).toBe("25");
          return HttpResponse.json([
            {
              id: 4509106740854784,
              slug: "the-goats",
              name: "The Goats",
            },
          ]);
        },
      ),
    );

    const params = prepareToolParams({
      tool: findTeams,
      params: {
        organizationSlug: "sentry-mcp-evals",
        query: null,
        regionUrl: null,
        cursor: null,
      },
      context,
    }) as Parameters<typeof findTeams.handler>[0];
    const result = await findTeams.handler(params, context);
    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(findTeamsOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "hasMore": false,
        "nextCursor": null,
        "teams": [
          {
            "id": "4509106740854784",
            "slug": "the-goats",
          },
        ],
      }
    `);
  });

  it("preserves search and cursor while returning a page of 25 teams", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/teams/",
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
              id: index + 1,
              slug: `team-${String(index + 1).padStart(3, "0")}`,
              name: `Team ${index + 1}`,
            })),
            {
              headers: {
                Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/teams/?cursor=page-2>; rel="next"; results="true"; cursor="page-2"',
              },
            },
          );
        },
      ),
    );

    const result = await findTeams.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        query: "example",
        regionUrl: null,
        cursor: "previous",
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    const structuredContent = findTeamsOutputSchema.parse(
      getStructuredContent(result),
    );
    expect(structuredContent.teams).toHaveLength(25);
    expect(structuredContent.teams.at(-1)).toEqual({
      slug: "team-025",
      id: "25",
    });
    expect(structuredContent).toMatchObject({
      hasMore: true,
      nextCursor: "page-2",
    });
  });
});
