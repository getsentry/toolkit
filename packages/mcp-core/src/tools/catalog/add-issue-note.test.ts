import { afterEach, describe, expect, it } from "vitest";
import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import addIssueNote from "./add-issue-note.js";

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

describe("add_issue_note", () => {
  it("includes MCP attribution and the comment reference returned by Sentry", async () => {
    mswServer.use(
      http.post("*/api/0/organizations/:org/issues/:issueId/notes/", () =>
        HttpResponse.json({
          id: "activity-1",
          commentId: "comment-1",
          type: "note",
          source: "mcp:claude",
          user: { name: "Jane Developer" },
          dateCreated: "2025-04-14T12:34:56.000Z",
          data: { text: "Investigating after the latest deploy." },
        }),
      ),
    );

    const result = await addIssueNote.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "CLOUDFLARE-MCP-41",
        text: "Investigating after the latest deploy.",
      },
      context,
    );

    expect(result).toMatchInlineSnapshot(`
      "# Added Note to Issue CLOUDFLARE-MCP-41 in **sentry-mcp-evals**

      **Comment ID**: comment-1
      **Type**: note
      **Author**: Jane Developer (Claude via MCP)
      **Created**: 2025-04-14T12:34:56.000Z
      **Text**: Investigating after the latest deploy.

      ## Response Notes

      - The note is visible in the issue activity feed."
    `);
    expect(result).not.toContain("activity-1");
  });

  it("serializes the created note", async () => {
    const result = await addIssueNote.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "CLOUDFLARE-MCP-41",
        text: "Investigating with the payments team.",
      },
      context,
    );

    expect(result).toMatchInlineSnapshot(`
      "# Added Note to Issue CLOUDFLARE-MCP-41 in **sentry-mcp-evals**

      **Comment ID**: 12345
      **Type**: note
      **Author**: Test User
      **Created**: 2025-04-14T12:34:56.000Z
      **Text**: Investigating with the payments team.

      ## Response Notes

      - The note is visible in the issue activity feed."
    `);
  });
});
