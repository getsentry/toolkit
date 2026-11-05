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
            "afterDays": 7,
            "author": "system",
            "commentId": null,
            "dateCreated": "2025-04-10T22:55:22.411Z",
            "id": "4633815464",
            "text": null,
            "type": "auto_set_ongoing",
          },
          {
            "author": "Jane Developer (Claude via MCP)",
            "commentId": null,
            "dateCreated": "2025-04-14T12:00:00.000Z",
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

  it("maps assignment data including the assignee email", async () => {
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
            "email": "assignee@example.com",
            "id": "42",
            "name": "Sam Owner",
            "type": "user",
          },
          "author": "Jane Developer",
          "commentId": null,
          "dateCreated": "2025-04-14T12:00:00.000Z",
          "id": "activity-assigned",
          "text": null,
          "type": "assigned",
        }
      `);
  });

  it("maps resolved-in-commit and pull request data with their authors", async () => {
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
              "author": {
                "email": "author@example.com",
                "name": "Commit Author",
              },
              "id": "abc123",
              "message": "fix: Handle null org",
              "repository": "getsentry/sentry-mcp",
            },
            "dateCreated": "2025-04-14T12:00:00.000Z",
            "id": "activity-commit",
            "text": null,
            "type": "set_resolved_in_commit",
          },
          {
            "author": "system",
            "commentId": null,
            "dateCreated": "2025-04-14T12:05:00.000Z",
            "id": "activity-pr",
            "pullRequest": {
              "author": {
                "email": "author@example.com",
                "name": "Commit Author",
              },
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
    expect(serialized).not.toContain("Longer body text");
    // Internal ids and release lists stay out of the mapped payload.
    expect(serialized).not.toContain("releases");
    expect(serialized).not.toContain('"id":"7"');
  });

  it("maps known activity data explicitly and drops the rest", async () => {
    const group = {
      id: "123",
      shortId: "CLOUDFLARE-MCP-42",
      shareId: "share-token-must-not-leak",
      assignedTo: { name: "Owner", email: "owner@example.com" },
      title: "Other group",
    };
    mswServer.use(
      http.get("*/api/0/organizations/:org/issues/:issueId/activities/", () =>
        HttpResponse.json({
          activity: [
            {
              id: "activity-unmerge",
              type: "unmerge_destination",
              dateCreated: "2025-04-14T12:00:00.000Z",
              user: null,
              data: { fingerprints: ["a", "b"], source: group },
            },
            {
              id: "activity-resolved-integration",
              type: "set_resolved",
              dateCreated: "2025-04-14T12:01:00.000Z",
              user: null,
              data: { integration_id: 98765, provider: "jira" },
            },
            {
              id: "activity-rca",
              type: "seer_rca_completed",
              dateCreated: "2025-04-14T12:02:00.000Z",
              user: null,
              data: {
                run_id: 55555,
                summary: "Null org slug reaches the API client.",
              },
            },
            {
              id: "activity-seer-pr",
              type: "seer_iteration_completed",
              dateCreated: "2025-04-14T12:03:00.000Z",
              user: null,
              data: {
                run_id: 55555,
                code_changes: [{ diff: "secret diff body" }],
                pull_requests: [
                  {
                    pull_request: {
                      pr_url: "https://github.com/getsentry/sentry-mcp/pull/7",
                    },
                  },
                ],
              },
            },
            {
              id: "activity-create-issue",
              type: "create_issue",
              dateCreated: "2025-04-14T12:04:00.000Z",
              user: null,
              data: {
                title: "Fix null org",
                provider: "Jira",
                location: "https://example.atlassian.net/browse/ENG-1",
                label: "ENG-1",
                new: true,
                integration_id: 98765,
              },
            },
            {
              id: "activity-resolved-by-age",
              type: "set_resolved_by_age",
              dateCreated: "2025-04-14T12:05:00.000Z",
              user: null,
              data: { age: 720 },
            },
            {
              id: "activity-deleted-pr",
              type: "pull_request_closed",
              dateCreated: "2025-04-14T12:06:00.000Z",
              user: null,
              data: { pullRequest: null },
            },
            {
              id: "activity-blank-commit",
              type: "set_resolved_in_commit",
              dateCreated: "2025-04-14T12:07:00.000Z",
              user: null,
              data: {
                commit: { id: "abc123", message: "\nbody only", author: null },
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
    const activity = (
      structuredContent as { activity: Array<Record<string, unknown>> }
    ).activity;
    const [
      unmerge,
      resolved,
      rca,
      seerPr,
      createIssue,
      resolvedByAge,
      deletedPr,
      blankCommit,
    ] = activity;
    expect(unmerge!.unmerge).toEqual({
      fingerprintCount: 2,
      source: { shortId: "CLOUDFLARE-MCP-42" },
      destination: null,
    });
    expect(Object.keys(resolved!).sort()).toEqual([
      "author",
      "commentId",
      "dateCreated",
      "id",
      "text",
      "type",
    ]);
    expect(rca!.text).toBe("Null org slug reaches the API client.");
    expect(seerPr!.pullRequestUrls).toEqual([
      "https://github.com/getsentry/sentry-mcp/pull/7",
    ]);
    expect(createIssue!.externalIssue).toEqual({
      title: "Fix null org",
      provider: "Jira",
      location: "https://example.atlassian.net/browse/ENG-1",
    });
    expect(resolvedByAge!.age).toBe(720);
    expect(deletedPr!.pullRequest).toBeNull();
    expect(blankCommit!.commit).toMatchObject({ id: "abc123", message: null });

    const serialized = JSON.stringify(structuredContent);
    for (const leaked of [
      "shareId",
      "share-token-must-not-leak",
      "integration_id",
      "98765",
      "run_id",
      "55555",
      "secret diff body",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("keeps assignee names that are emails", async () => {
    mockActivity({
      id: "activity-assigned-email-name",
      type: "assigned",
      dateCreated: "2025-04-14T12:00:00.000Z",
      user: null,
      data: {
        assignee: "43",
        assigneeName: "jane@corp.com",
        assigneeType: "user",
      },
    } as IssueActivity);

    const result = await getIssueActivity.handler(
      { ...params, includeComments: false },
      context,
    );
    const [assigned] = getStructuredContent<{
      activity: Array<{ assignee?: { name: string | null } }>;
    }>(result).activity;
    expect(assigned!.assignee).toEqual({
      id: "43",
      type: "user",
      name: "jane@corp.com",
      email: null,
    });
  });
});
