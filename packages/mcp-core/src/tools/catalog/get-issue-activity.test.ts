import { mswServer } from "@sentry/mcp-server-mocks";
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import type { IssueActivity } from "../../api-client/types";
import getIssueActivity from "./get-issue-activity.js";

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

    expect(result).toMatchInlineSnapshot(`
      "# Activity for Issue CLOUDFLARE-MCP-41 in **sentry-mcp-evals**

      ## Activity

      - 2025-04-10T22:55:22.411Z: auto_set_ongoing by system (4633815464)
        - Data: {"after_days":7}
      - 2025-04-14T12:00:00.000Z: note by Jane Developer (Claude via MCP) (4633816000)
        - Investigating after the latest deploy.

      ## Comments

      - 2025-04-14T12:00:00.000Z: note by Jane Developer (Claude via MCP) (4633816000)
        - Investigating after the latest deploy.

      ## Response Notes

      - Use the Sentry tool \`add_issue_note\` to add a new human-visible issue comment.
      "
    `);
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
      const [activity, comments] = result.split("## Comments");
      expect(activity).toContain(`by ${attribution} (activity-1)`);
      expect(comments).toContain(`by ${attribution} (activity-1)`);
      expect(result).not.toContain("Comment ID:");
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
      sentry_app: { name: "Example App", slug: "example-app" },
      data: { text: "Investigating after the latest deploy." },
    });

    const result = await getIssueActivity.handler(params, context);
    expect(result).toMatchInlineSnapshot(`
      "# Activity for Issue CLOUDFLARE-MCP-41 in **sentry-mcp-evals**

      ## Activity

      - 2025-04-14T12:00:00.000Z: note by Example App (activity-1)
        - Comment ID: comment-1
        - Investigating after the latest deploy.

      ## Comments

      - 2025-04-14T12:00:00.000Z: note by Example App (activity-1)
        - Comment ID: comment-1
        - Investigating after the latest deploy.

      ## Response Notes

      - Use the Sentry tool \`add_issue_note\` to add a new human-visible issue comment.
      "
    `);
    expect(result).not.toContain("by system");
    expect(result).not.toContain("via API");
  });

  it("omits add_issue_note guidance when the tool is unavailable", async () => {
    const result = await getIssueActivity.handler(params, {
      ...context,
      availableToolNames: new Set([
        "get_issue_activity",
        "execute_sentry_tool",
      ]),
      directToolNames: new Set(["execute_sentry_tool"]),
    });

    expect(result).not.toContain("Response Notes");
    expect(result).not.toContain("add_issue_note");
  });
});
