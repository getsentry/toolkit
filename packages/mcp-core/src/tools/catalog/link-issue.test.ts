import { issueFixture, mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import linkIssue from "./link-issue";
import unlinkIssue from "./unlink-issue";

const params = {
  organizationSlug: "sentry-mcp-evals",
  issueId: issueFixture.shortId,
  regionUrl: null,
  externalIssueUrl: "https://github.com/example/repo/issues/42",
};
const context = { accessToken: "test-token", constraints: {} };
const endpoint = `https://sentry.io/api/0/organizations/${params.organizationSlug}/issues/${issueFixture.id}/integrations/`;
const externalIssue = {
  id: "72",
  key: "example/repo#42",
  displayName: "example/repo#42",
  url: params.externalIssueUrl,
};
const integration = {
  id: "11",
  name: "example",
  domainName: "github.com/example",
  status: "active",
  provider: { key: "github", name: "GitHub" },
  externalIssues: [],
};

describe("link_issue", () => {
  it("links using the resolved numeric issue ID and projects the result", async () => {
    mswServer.use(
      http.get(endpoint, () => HttpResponse.json([integration])),
      http.put(`${endpoint}11/`, async ({ request }) => {
        expect(await request.json()).toEqual({
          externalIssue: params.externalIssueUrl,
        });
        return HttpResponse.json(
          { ...externalIssue, integrationId: 11, internalOnly: "hidden" },
          { status: 201 },
        );
      }),
    );
    expect(await linkIssue.handler(params, context)).toMatchInlineSnapshot(`
      {
        "structuredContent": {
          "externalIssue": {
            "displayName": "example/repo#42",
            "provider": "github",
            "url": "https://github.com/example/repo/issues/42",
          },
          "issueId": "CLOUDFLARE-MCP-41",
          "issueUrl": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41",
          "organizationSlug": "sentry-mcp-evals",
          "status": "linked",
        },
      }
    `);
  });
});

describe.each([linkIssue, unlinkIssue])("$name constraints", (tool) => {
  it("rejects an issue from another project before discovering or mutating links", async () => {
    let requests = 0;
    mswServer.use(
      http.all(`${endpoint}*`, () => {
        requests++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await expect(
      tool.handler(params, {
        ...context,
        constraints: { projectSlug: "other-project" },
      }),
    ).rejects.toThrow("outside the active project constraint");
    expect(requests).toBe(0);
  });

  it("rejects an issue URL outside the constrained organization", async () => {
    await expect(
      tool.handler(
        {
          ...params,
          issueUrl: "https://other-org.sentry.io/issues/123/",
        },
        {
          ...context,
          constraints: { organizationSlug: params.organizationSlug },
        },
      ),
    ).rejects.toThrow("outside the active organization constraint");
  });
});
