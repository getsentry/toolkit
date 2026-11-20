import { mswServer, releaseFixture } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { describe, it, expect } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import { getServerContext } from "../../test-setup.js";
import findReleases, { findReleasesOutputSchema } from "./find-releases.js";

describe("find_releases", () => {
  it("works without project", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/releases/",
        ({ request }) => {
          const searchParams = new URL(request.url).searchParams;
          expect(searchParams.get("per_page")).toBe("26");
          expect(searchParams.has("query")).toBe(false);
          return HttpResponse.json([
            {
              ...releaseFixture,
              projects: releaseFixture.projects.map(
                (project: (typeof releaseFixture.projects)[number]) => ({
                  ...project,
                  name: "Cloudflare MCP",
                }),
              ),
            },
          ]);
        },
      ),
    );

    const result = await findReleases.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: null,
        regionUrl: null,
        query: null,
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(findReleasesOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "hasMore": false,
        "releases": [
          {
            "dateCreated": "2025-04-13T19:54:21.764Z",
            "dateReleased": null,
            "firstEvent": "2025-04-13T19:54:21.000Z",
            "lastCommit": null,
            "lastDeploy": null,
            "lastEvent": "2025-04-13T20:28:23.000Z",
            "newIssues": 0,
            "projects": [
              "cloudflare-mcp",
            ],
            "version": "8ce89484-0fec-4913-a2cd-e8e2d41dee36",
          },
        ],
      }
    `);
  });

  it("works with project", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/releases/",
        ({ request }) => {
          const searchParams = new URL(request.url).searchParams;
          expect(searchParams.get("per_page")).toBe("26");
          expect(searchParams.has("query")).toBe(false);
          return HttpResponse.json([releaseFixture]);
        },
      ),
    );

    const result = await findReleases.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        regionUrl: null,
        query: null,
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toEqual({
      releases: [
        {
          version: "8ce89484-0fec-4913-a2cd-e8e2d41dee36",
          dateCreated: "2025-04-13T19:54:21.764Z",
          dateReleased: null,
          firstEvent: "2025-04-13T19:54:21.000Z",
          lastEvent: "2025-04-13T20:28:23.000Z",
          newIssues: 0,
          projects: ["cloudflare-mcp"],
          lastCommit: null,
          lastDeploy: null,
        },
      ],
      hasMore: false,
    });
  });

  it("lists organization releases when projectSlug is all", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/releases/",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("query")).toBe("8ce8");
          return HttpResponse.json([releaseFixture]);
        },
      ),
      http.get(
        "https://sentry.io/api/0/projects/sentry-mcp-evals/all/releases/",
        () =>
          HttpResponse.json(
            { detail: "The requested resource does not exist" },
            { status: 404 },
          ),
      ),
    );

    const result = await findReleases.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "all",
        regionUrl: null,
        query: "8ce8",
      },
      getServerContext(),
    );

    expect(
      getStructuredContent<{ releases: Array<{ version: string }> }>(result)
        .releases[0]?.version,
    ).toBe("8ce89484-0fec-4913-a2cd-e8e2d41dee36");
  });

  it("maps commit and deploy summaries without leaking upstream fields", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/releases/",
        () =>
          HttpResponse.json([
            {
              ...releaseFixture,
              version: "backend@1.2.3+build.4",
              shortVersion: "backend@1.2.3",
              dateReleased: "2025-04-14T08:00:00Z",
              lastCommit: {
                id: 12345,
                message: "Ship release",
                dateCreated: "2025-04-14T07:30:00Z",
                author: {
                  name: null,
                  email: "developer@example.com",
                  avatarUrl: "https://example.com/avatar.png",
                },
                repository: { name: "backend" },
              },
              lastDeploy: {
                id: 67890,
                environment: "production",
                dateStarted: "2025-04-14T07:45:00Z",
                dateFinished: "2025-04-14T08:00:00Z",
                url: "https://example.com/deploy/67890",
              },
              secretBackendField: "must-not-leak",
            },
          ]),
      ),
    );

    const result = await findReleases.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: null,
        regionUrl: null,
        query: "backend@1.2",
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    expect(getStructuredContent(result)).toEqual({
      releases: [
        {
          version: "backend@1.2.3+build.4",
          dateCreated: "2025-04-13T19:54:21.764Z",
          dateReleased: "2025-04-14T08:00:00.000Z",
          firstEvent: "2025-04-13T19:54:21.000Z",
          lastEvent: "2025-04-13T20:28:23.000Z",
          newIssues: 0,
          projects: ["cloudflare-mcp"],
          lastCommit: {
            id: "12345",
            message: "Ship release",
            author: "developer@example.com",
            dateCreated: "2025-04-14T07:30:00.000Z",
          },
          lastDeploy: {
            id: "67890",
            environment: "production",
            dateStarted: "2025-04-14T07:45:00.000Z",
            dateFinished: "2025-04-14T08:00:00.000Z",
          },
        },
      ],
      hasMore: false,
    });
  });

  it("reports more results and returns only the first 25 releases", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/sentry-mcp-evals/releases/",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("per_page")).toBe("26");
          return HttpResponse.json(
            Array.from({ length: 26 }, (_, index) => ({
              ...releaseFixture,
              id: index + 1,
              version: `release-${String(index + 1).padStart(2, "0")}`,
              shortVersion: `release-${String(index + 1).padStart(2, "0")}`,
            })),
          );
        },
      ),
    );

    const result = await findReleases.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: null,
        regionUrl: null,
        query: null,
      },
      getServerContext(),
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent<{
      releases: Array<{ version: string }>;
      hasMore: boolean;
    }>(result);
    expect(structuredContent.releases).toHaveLength(25);
    expect(structuredContent.releases.at(-1)?.version).toBe("release-25");
    expect(structuredContent.hasMore).toBe(true);
  });
});
