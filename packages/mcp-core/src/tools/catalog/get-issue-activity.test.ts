import { mswServer } from "@sentry/mcp-server-mocks";
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import type { IssueActivity } from "../../api-client/types";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import getIssueActivity, {
  getIssueActivityOutputSchema,
} from "./get-issue-activity.js";

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
  includeComments: true,
  limit: 25,
};

type ActivityOutput = {
  activity: Array<{ author: string; commentId: string | null }>;
  comments: Array<{ author: string; commentId: string | null }> | null;
};

function mockActivity(activity: IssueActivity) {
  mswServer.use(
    http.get("*/api/0/organizations/:org/issues/:issueId/activities/", () =>
      HttpResponse.json({ activity: [activity] }),
    ),
    http.get("*/api/0/organizations/:org/issues/:issueId/notes/", () =>
      HttpResponse.json([activity]),
    ),
  );
}

afterEach(() => {
  mswServer.resetHandlers();
});

describe("get_issue_activity", () => {
  it("serializes issue activity and comments", async () => {
    const result = await getIssueActivity.handler(params, context);

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(getIssueActivity.outputSchema).toBe(getIssueActivityOutputSchema);
    expect(getIssueActivityOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "activity": [
          {
            "author": "system",
            "commentId": null,
            "dateCreated": "2025-04-10T22:55:22.411Z",
            "details": "{"after_days":7}",
            "id": "4633815464",
            "text": null,
            "type": "auto_set_ongoing",
          },
          {
            "author": "Jane Developer (Claude via MCP)",
            "commentId": null,
            "dateCreated": "2025-04-14T12:00:00.000Z",
            "details": null,
            "id": "4633816000",
            "text": "Investigating after the latest deploy.",
            "type": "note",
          },
        ],
        "comments": [
          {
            "author": "Jane Developer (Claude via MCP)",
            "commentId": null,
            "dateCreated": "2025-04-14T12:00:00.000Z",
            "details": null,
            "id": "4633816000",
            "text": "Investigating after the latest deploy.",
            "type": "note",
          },
        ],
        "issueId": "CLOUDFLARE-MCP-41",
        "issueUrl": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41",
        "organizationSlug": "sentry-mcp-evals",
      }
    `);
  });

  it("returns null comments when comments are not requested", async () => {
    const result = await getIssueActivity.handler(
      { ...params, includeComments: false },
      context,
    );

    const structuredContent = getStructuredContent<ActivityOutput>(result);
    expect(structuredContent.comments).toBeNull();
    expect(structuredContent.activity.length).toBeGreaterThan(0);
  });

  it.each([
    ["mcp:claude-code", "Claude via MCP"],
    ["mcp:cursor", "Cursor via MCP"],
    ["mcp", "via MCP"],
    ["mcp:new-client", "via MCP"],
    ["api", "via API"],
    ["sentry-cli", "via Sentry CLI"],
    ["web", null],
    [null, null],
    [undefined, null],
  ])(
    "formats source %s in both activity and comments",
    async (source, label) => {
      mockActivity({
        id: "activity-1",
        type: "note",
        source,
        user: { name: "Jane Developer" },
      });
      const result = await getIssueActivity.handler(params, context);
      const attribution = label
        ? `Jane Developer (${label})`
        : "Jane Developer";
      const { activity, comments } =
        getStructuredContent<ActivityOutput>(result);
      expect(activity[0]).toMatchObject({
        author: attribution,
        commentId: null,
      });
      expect(comments?.[0]).toMatchObject({
        author: attribution,
        commentId: null,
      });
    },
  );

  it("attributes Sentry Apps by name and separates comment IDs from activity IDs", async () => {
    mockActivity({
      id: "activity-1",
      commentId: "comment-1",
      type: "note",
      dateCreated: "2025-04-14T12:00:00.000Z",
      source: "api",
      user: null,
      sentry_app: {
        name: "Example App",
        slug: "example-app",
        uuid: "app-uuid",
      },
      data: { text: "Investigating after the latest deploy." },
      backendOnlyField: "must-not-leak",
    } as IssueActivity);

    const result = await getIssueActivity.handler(params, context);
    const structuredContent = getStructuredContent(result);
    expect(getIssueActivityOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "activity": [
          {
            "author": "Example App",
            "commentId": "comment-1",
            "dateCreated": "2025-04-14T12:00:00.000Z",
            "details": null,
            "id": "activity-1",
            "text": "Investigating after the latest deploy.",
            "type": "note",
          },
        ],
        "comments": [
          {
            "author": "Example App",
            "commentId": "comment-1",
            "dateCreated": "2025-04-14T12:00:00.000Z",
            "details": null,
            "id": "activity-1",
            "text": "Investigating after the latest deploy.",
            "type": "note",
          },
        ],
        "issueId": "CLOUDFLARE-MCP-41",
        "issueUrl": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41",
        "organizationSlug": "sentry-mcp-evals",
      }
    `);
    const serialized = JSON.stringify(structuredContent);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("app-uuid");
    expect(serialized).not.toContain("via API");
  });

  it("maps assignment data without the assignee email", async () => {
    mockActivity({
      id: "activity-assigned",
      type: "assigned",
      dateCreated: "2025-04-14T12:00:00.000Z",
      user: { name: "Jane Developer" },
      data: {
        assignee: "42",
        assigneeEmail: "assignee@example.com",
        assigneeName: "Sam Owner",
        assigneeType: "user",
      },
    } as IssueActivity);

    const result = await getIssueActivity.handler(
      { ...params, includeComments: false },
      context,
    );
    const structuredContent = getStructuredContent(result);
    expect(getIssueActivityOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect((structuredContent as { activity: unknown[] }).activity[0])
      .toMatchInlineSnapshot(`
      {
        "assignee": {
          "id": "42",
          "name": "Sam Owner",
          "type": "user",
        },
        "author": "Jane Developer",
        "commentId": null,
        "dateCreated": "2025-04-14T12:00:00.000Z",
        "details": null,
        "id": "activity-assigned",
        "text": null,
        "type": "assigned",
      }
    `);
    const serialized = JSON.stringify(structuredContent);
    expect(serialized).not.toContain("assignee@example.com");
    expect(serialized).not.toMatch(/email/i);
  });

  it("maps resolved-in-commit and pull request data without authors", async () => {
    const author = {
      id: "7",
      name: "Commit Author",
      email: "author@example.com",
    };
    mswServer.use(
      http.get("*/api/0/organizations/:org/issues/:issueId/activities/", () =>
        HttpResponse.json({
          activity: [
            {
              id: "activity-commit",
              type: "set_resolved_in_commit",
              dateCreated: "2025-04-14T12:00:00.000Z",
              user: null,
              data: {
                commit: {
                  id: "abc123",
                  message: "fix: Handle null org\n\nLonger body text",
                  dateCreated: "2025-04-14T11:00:00.000Z",
                  repository: { id: "1", name: "getsentry/sentry-mcp" },
                  author,
                  releases: [{ version: "1.2.3", authors: [author] }],
                },
              },
            },
            {
              id: "activity-pr",
              type: "set_resolved_in_pull_request",
              dateCreated: "2025-04-14T12:05:00.000Z",
              user: null,
              data: {
                pullRequest: {
                  id: "99",
                  title: "Fix null org handling",
                  externalUrl:
                    "https://github.com/getsentry/sentry-mcp/pull/99",
                  repository: { id: "1", name: "getsentry/sentry-mcp" },
                  author,
                },
              },
            },
          ],
        }),
      ),
    );

    const result = await getIssueActivity.handler(
      { ...params, includeComments: false },
      context,
    );
    const structuredContent = getStructuredContent(result);
    expect(getIssueActivityOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect((structuredContent as { activity: unknown[] }).activity)
      .toMatchInlineSnapshot(`
      [
        {
          "author": "system",
          "commentId": null,
          "commit": {
            "id": "abc123",
            "message": "fix: Handle null org",
            "repository": "getsentry/sentry-mcp",
          },
          "dateCreated": "2025-04-14T12:00:00.000Z",
          "details": null,
          "id": "activity-commit",
          "text": null,
          "type": "set_resolved_in_commit",
        },
        {
          "author": "system",
          "commentId": null,
          "dateCreated": "2025-04-14T12:05:00.000Z",
          "details": null,
          "id": "activity-pr",
          "pullRequest": {
            "id": "99",
            "repository": "getsentry/sentry-mcp",
            "title": "Fix null org handling",
          },
          "text": null,
          "type": "set_resolved_in_pull_request",
        },
      ]
    `);
    const serialized = JSON.stringify(structuredContent);
    expect(serialized).not.toContain("author@example.com");
    expect(serialized).not.toContain("Commit Author");
    expect(serialized).not.toContain("Longer body text");
  });

  it("bounds other activity data and drops nested emails", async () => {
    mockActivity({
      id: "activity-unmerge",
      type: "unmerge_destination",
      dateCreated: "2025-04-14T12:00:00.000Z",
      user: null,
      data: {
        fingerprints: ["a".repeat(40)],
        source: {
          id: "123",
          assignedTo: { name: "Owner", email: "owner@example.com" },
          contact: "contact@example.com",
          title: "x".repeat(300),
        },
      },
    } as IssueActivity);

    const result = await getIssueActivity.handler(
      { ...params, includeComments: false },
      context,
    );
    const [entry] = getStructuredContent<{
      activity: Array<{ details: string | null }>;
    }>(result).activity;
    expect(entry!.details).toMatch(/^\{"fingerprints":/);
    expect(entry!.details!.length).toBe(203);
    expect(entry!.details).not.toContain("example.com");
    expect(entry!.details).not.toMatch(/email/i);
  });
});
