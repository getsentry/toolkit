import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import getIssueUserReports, {
  getIssueUserReportsOutputSchema,
} from "./get-issue-user-reports.js";

const context = {
  constraints: {
    organizationSlug: null,
  },
  accessToken: "access-token",
  userId: "1",
};

afterEach(() => {
  mswServer.resetHandlers();
});

describe("get_issue_user_reports", () => {
  it("serializes user feedback for an issue", async () => {
    const result = await getIssueUserReports.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "CLOUDFLARE-MCP-41",
        cursor: null,
        limit: 25,
      },
      context,
    );

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(getIssueUserReports.outputSchema).toBe(
      getIssueUserReportsOutputSchema,
    );
    expect(getIssueUserReportsOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "issueId": "CLOUDFLARE-MCP-41",
        "nextCursor": null,
        "organizationSlug": "sentry-mcp-evals",
        "reports": [
          {
            "comments": "i am currently testing it",
            "dateCreated": "2026-06-22T02:37:27.878Z",
            "eventId": "957c1ee8f31e4e68a57b637dad557b32",
            "id": "11974227",
            "reporter": "Example Reporter",
          },
          {
            "comments": "anonymous report with no event user",
            "dateCreated": "2026-06-22T03:10:11.123Z",
            "eventId": "057c1ee8f31e4e68a57b637dad557b33",
            "id": "11974228",
            "reporter": "anonymous",
          },
          {
            "comments": "event user shell without identity",
            "dateCreated": "2026-06-22T03:45:12.456Z",
            "eventId": "157c1ee8f31e4e68a57b637dad557b34",
            "id": "11974229",
            "reporter": "anonymous",
          },
        ],
      }
    `);
  });

  it("returns the next cursor without leaking reporter account fields", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/:org/issues/:issueId/user-reports/",
        ({ request }) => {
          const url = new URL(request.url);
          expect(url.searchParams.get("per_page")).toBe("1");
          expect(url.searchParams.get("cursor")).toBe("page-1");
          return HttpResponse.json(
            [
              {
                id: "11974229",
                eventID: "157c1ee8f31e4e68a57b637dad557b34",
                name: "",
                email: "",
                comments: "reported by event user",
                dateCreated: "2026-06-22T04:20:21.987654Z",
                user: {
                  id: "user-456",
                  username: "event-user",
                  email: null,
                  name: null,
                  ipAddress: "203.0.113.7",
                  avatarUrl: "https://example.com/avatar.png",
                },
                event: {
                  id: "157c1ee8f31e4e68a57b637dad557b34",
                  eventID: "157c1ee8f31e4e68a57b637dad557b34",
                },
              },
            ],
            {
              headers: {
                Link: '<https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/user-reports/?cursor=page-2>; rel="next"; results="true"; cursor="page-2"',
              },
            },
          );
        },
      ),
    );

    const result = await getIssueUserReports.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "CLOUDFLARE-MCP-41",
        cursor: "page-1",
        limit: 1,
      },
      context,
    );

    const structuredContent = getStructuredContent(result);
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "issueId": "CLOUDFLARE-MCP-41",
        "nextCursor": "page-2",
        "organizationSlug": "sentry-mcp-evals",
        "reports": [
          {
            "comments": "reported by event user",
            "dateCreated": "2026-06-22T04:20:21.987Z",
            "eventId": "157c1ee8f31e4e68a57b637dad557b34",
            "id": "11974229",
            "reporter": "event-user",
          },
        ],
      }
    `);
    const serialized = JSON.stringify(structuredContent);
    expect(serialized).not.toContain("203.0.113.7");
    expect(serialized).not.toContain("avatar.png");
  });
});
