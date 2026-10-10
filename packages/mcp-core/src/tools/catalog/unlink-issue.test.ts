import { issueFixture, mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
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

describe("unlink_issue", () => {
  it("removes only the association and returns its resulting state", async () => {
    let deletes = 0;
    mswServer.use(
      http.get(endpoint, () =>
        HttpResponse.json([
          { ...integration, externalIssues: [externalIssue] },
        ]),
      ),
      http.delete(`${endpoint}11/`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("externalIssue")).toBe(
          "72",
        );
        deletes++;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    expect(await unlinkIssue.handler(params, context)).toMatchInlineSnapshot(`
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
          "status": "not_linked",
        },
      }
    `);
    expect(deletes).toBe(1);
  });
});
