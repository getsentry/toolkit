import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { issueFixture, mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { buildServer } from "../../server.js";
import type { Skill } from "../../skills.js";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import type { ServerContext } from "../../types.js";
import findRelatedIssues, {
  findRelatedIssuesOutputSchema,
} from "./find-related-issues.js";

vi.mock("@sentry/core/server", () => ({
  wrapMcpServerWithSentry: vi.fn((server) => server),
}));

type Output = z.infer<typeof findRelatedIssuesOutputSchema>;

const RELATED_URL =
  "https://sentry.io/api/0/organizations/:org/issues/:issueId/related/";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

const params = {
  organizationSlug: "sentry-mcp-evals",
  regionUrl: null,
  issueId: "CLOUDFLARE-MCP-41",
  types: null,
  limit: 10,
};

afterEach(() => {
  mswServer.resetHandlers();
});

describe("find_related_issues", () => {
  it("lists related issues with why each is related", async () => {
    const result = await findRelatedIssues.handler(params, context);

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(findRelatedIssues.outputSchema).toBe(findRelatedIssuesOutputSchema);
    expect(findRelatedIssuesOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    // Upstream-only fields stay out of the passthrough issue schema's output.
    expect(JSON.stringify(structuredContent)).not.toMatch(
      /permalink|statusDetails|annotations|eventId/,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "issueId": "CLOUDFLARE-MCP-41",
        "notes": [],
        "organizationSlug": "sentry-mcp-evals",
        "relatedIssues": [
          {
            "assignedTo": null,
            "assigneeEmail": null,
            "culprit": "Object.fetch(index)",
            "firstSeen": "2025-04-03T22:52:01.118000Z",
            "issueCategory": "error",
            "lastSeen": "2025-04-11T09:12:44Z",
            "occurrences": 12,
            "projectSlug": "CLOUDFLARE-MCP",
            "relations": [
              {
                "score": 0.9787,
                "type": "similar_stacktrace",
              },
              {
                "score": null,
                "type": "same_trace",
              },
            ],
            "reporter": null,
            "seerActionability": null,
            "shortId": "CLOUDFLARE-MCP-42",
            "status": "resolved",
            "substatus": null,
            "title": "Error: Tool list_projects is already registered",
            "url": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-42",
            "usersImpacted": 1,
          },
          {
            "assignedTo": null,
            "assigneeEmail": null,
            "culprit": "loadOrganizations(app/organizations)",
            "firstSeen": "2025-04-03T22:51:20.010000Z",
            "issueCategory": "error",
            "lastSeen": "2025-04-12T11:34:12Z",
            "occurrences": 48,
            "projectSlug": "web",
            "relations": [
              {
                "score": null,
                "type": "same_trace",
              },
            ],
            "reporter": null,
            "seerActionability": null,
            "shortId": "WEB-1A2",
            "status": "unresolved",
            "substatus": "ongoing",
            "title": "TypeError: Failed to fetch",
            "url": "https://sentry-mcp-evals.sentry.io/issues/WEB-1A2",
            "usersImpacted": 9,
          },
        ],
        "relationTypes": [
          {
            "detail": null,
            "status": "ok",
            "traceId": null,
            "type": "similar_stacktrace",
          },
          {
            "detail": null,
            "status": "ok",
            "traceId": "3032af8bcdfe4423b937fc5c041d5d82",
            "type": "same_trace",
          },
          {
            "detail": "Only metric issues have contributing issues.",
            "status": "not_applicable",
            "traceId": null,
            "type": "contributing",
          },
        ],
        "suggestedActions": [
          {
            "arguments": {
              "organizationSlug": "sentry-mcp-evals",
              "resourceId": "CLOUDFLARE-MCP-42",
              "resourceType": "issue",
            },
            "reason": "Inspect the most closely related issue.",
            "toolName": "get_sentry_resource",
            "type": "tool_call",
          },
        ],
      }
    `);
  });

  it("asks Sentry for only the requested types, up to the limit", async () => {
    let requested: URLSearchParams | undefined;
    mswServer.use(
      http.get(RELATED_URL, ({ request }) => {
        requested = new URL(request.url).searchParams;
        return HttpResponse.json({ data: [], meta: { types: [] } });
      }),
    );

    await findRelatedIssues.handler(
      { ...params, types: ["same_trace", "contributing"], limit: 5 },
      context,
    );

    expect(requested?.getAll("type")).toEqual(["same_trace", "contributing"]);
    expect(requested?.get("limit")).toBe("5");
  });

  it("passes on Sentry's reason when a type is unavailable", async () => {
    mswServer.use(
      http.get(RELATED_URL, () =>
        HttpResponse.json({
          data: [],
          meta: {
            types: [
              {
                type: "similar_stacktrace",
                status: "unavailable",
                detail:
                  "Similar stack traces are temporarily unavailable. Try again later.",
                eventId: "7ca573c0f4814912aaa9bdc77d1a7d51",
              },
              {
                type: "same_trace",
                status: "unavailable",
                detail:
                  "Trace search is temporarily unavailable. Try again later.",
                traceId: "3032af8bcdfe4423b937fc5c041d5d82",
              },
              {
                type: "contributing",
                status: "not_applicable",
                detail: "Only metric issues have contributing issues.",
              },
            ],
          },
        }),
      ),
    );

    const result = await findRelatedIssues.handler(params, context);
    const structuredContent = getStructuredContent<Output>(result);

    expect(structuredContent.relatedIssues).toEqual([]);
    expect(structuredContent.suggestedActions).toEqual([]);
    expect(structuredContent.notes).toMatchInlineSnapshot(`
      [
        "Similar stack traces are temporarily unavailable. Try again later.",
        "Trace search is temporarily unavailable. Try again later. To look for them now, run search_issues with the query \`trace:3032af8bcdfe4423b937fc5c041d5d82\`.",
      ]
    `);
  });

  it("leaves out issues from other projects in a project-scoped session", async () => {
    const result = await findRelatedIssues.handler(params, {
      ...context,
      constraints: {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "CLOUDFLARE-MCP",
      },
    });
    const structuredContent = getStructuredContent<Output>(result);

    expect(
      structuredContent.relatedIssues.map((issue) => issue.shortId),
    ).toEqual(["CLOUDFLARE-MCP-42"]);
    expect(structuredContent.notes).toEqual([
      "Related issues outside the CLOUDFLARE-MCP project are left out.",
    ]);
  });
});

describe("find_related_issues through the MCP server", () => {
  const serverContext: ServerContext = {
    accessToken: "test-token",
    grantedSkills: new Set<Skill>(["inspect", "triage"]),
    constraints: { organizationSlug: null, projectSlug: null },
    sentryHost: "sentry.io",
  };

  async function withClient<T>(run: (client: Client) => Promise<T>) {
    const server = buildServer({ context: serverContext });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "related-issues-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      return await run(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("finds an issue's siblings from its URL, then opens the suggested one", async () => {
    let relatedRequest: URL | undefined;
    mswServer.use(
      http.get(RELATED_URL, ({ request }) => {
        relatedRequest = new URL(request.url);
        return HttpResponse.json({
          data: [
            {
              issue: issueFixture,
              relations: [{ type: "similar_stacktrace", score: 0.97 }],
            },
          ],
          meta: {
            types: [
              { type: "similar_stacktrace", status: "ok" },
              {
                type: "same_trace",
                status: "not_applicable",
                detail: "This issue's event has no trace.",
              },
              {
                type: "contributing",
                status: "not_applicable",
                detail: "Only metric issues have contributing issues.",
              },
            ],
          },
        });
      }),
    );

    await withClient(async (client) => {
      const related = await client.callTool({
        name: "find_related_issues",
        arguments: {
          issueUrl:
            "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-42",
        },
      });
      expect(related.isError).toBeFalsy();

      // The issue comes from the URL. With no types given, every known type is
      // named, so Sentry can't return one the output schema rejects.
      expect(relatedRequest?.pathname).toBe(
        "/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-42/related/",
      );
      expect(relatedRequest?.searchParams.getAll("type")).toEqual([
        "similar_stacktrace",
        "same_trace",
        "contributing",
      ]);
      expect(relatedRequest?.searchParams.get("limit")).toBe("10");

      const next = getStructuredContent<Output>(related).suggestedActions.at(0);
      expect(next).toMatchObject({
        toolName: "get_sentry_resource",
        arguments: { resourceType: "issue", resourceId: "CLOUDFLARE-MCP-41" },
      });
      if (!next) {
        throw new Error("Expected a suggested action");
      }

      // The agent runs the suggested call exactly as given.
      const opened = await client.callTool({
        name: next.toolName,
        arguments: next.arguments,
      });
      expect(opened.isError).toBeFalsy();
      expect(JSON.stringify(opened)).toContain(
        "Tool list_organizations is already registered",
      );
    });
  });

  it("returns Sentry's reason as a tool error when every type fails", async () => {
    mswServer.use(
      http.get(RELATED_URL, () =>
        HttpResponse.json(
          {
            detail:
              "Related issues are temporarily unavailable. Try again later.",
          },
          { status: 503 },
        ),
      ),
    );

    // A 503 is retried with backoff before the error reaches the agent, hence
    // the longer timeout.
    const result = await withClient((client) =>
      client.callTool({
        name: "find_related_issues",
        arguments: {
          organizationSlug: "sentry-mcp-evals",
          issueId: "CLOUDFLARE-MCP-41",
        },
      }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      "Related issues are temporarily unavailable. Try again later.",
    );
  }, 10_000);
});
