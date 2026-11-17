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
            "email": "reporter@example.com",
            "eventId": "957c1ee8f31e4e68a57b637dad557b32",
            "id": "11974227",
            "name": "Example Reporter",
            "user": {
              "email": "reporter@example.com",
              "id": "user-123",
              "ipAddress": "203.0.113.10",
              "name": "Example Reporter",
              "username": "example-reporter",
            },
          },
          {
            "comments": "anonymous report with no event user",
            "dateCreated": "2026-06-22T03:10:11.123Z",
            "email": null,
            "eventId": "057c1ee8f31e4e68a57b637dad557b33",
            "id": "11974228",
            "name": null,
            "user": null,
          },
          {
            "comments": "event user shell without identity",
            "dateCreated": "2026-06-22T03:45:12.456Z",
            "email": null,
            "eventId": "157c1ee8f31e4e68a57b637dad557b34",
            "id": "11974229",
            "name": null,
            "user": null,
          },
        ],
      }
    `);
  });

  it("returns the event user's identity and IP address with the next cursor", async () => {
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
                // Sentry fills both names from the username when no real
                // name exists.
                name: "event-user",
                email: "",
                comments: "reported by event user",
                dateCreated: "2026-06-22T04:20:21.987654Z",
                user: {
                  id: "user-456",
                  username: "event-user",
                  email: null,
                  name: "event-user",
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
            "email": null,
            "eventId": "157c1ee8f31e4e68a57b637dad557b34",
            "id": "11974229",
            "name": null,
            "user": {
              "email": null,
              "id": "user-456",
              "ipAddress": "203.0.113.7",
              "name": null,
              "username": "event-user",
            },
          },
        ],
      }
    `);
    // The avatar URL is presentation data, not user data the report stored.
    expect(JSON.stringify(structuredContent)).not.toContain("avatar.png");
  });

  it("returns null names when Sentry only copied the reporter email", async () => {
    mswServer.use(
      http.get(
        "https://sentry.io/api/0/organizations/:org/issues/:issueId/user-reports/",
        () =>
          HttpResponse.json([
            {
              id: "11974230",
              eventID: "257c1ee8f31e4e68a57b637dad557b35",
              name: "jane@example.com",
              email: "jane@example.com",
              comments: "no name given",
              dateCreated: "2026-06-22T05:00:00.000000Z",
              user: {
                id: "user-789",
                username: null,
                email: "jane@example.com",
                name: "jane@example.com",
                ipAddress: "198.51.100.4",
                avatarUrl: null,
              },
              event: {
                id: "257c1ee8f31e4e68a57b637dad557b35",
                eventID: "257c1ee8f31e4e68a57b637dad557b35",
              },
            },
          ]),
      ),
    );

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

    const [report] = getIssueUserReportsOutputSchema.parse(
      getStructuredContent(result),
    ).reports;
    expect(report).toMatchObject({
      name: null,
      email: "jane@example.com",
      user: {
        id: "user-789",
        name: null,
        email: "jane@example.com",
        ipAddress: "198.51.100.4",
      },
    });
  });
});
