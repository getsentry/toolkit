import { afterEach, describe, expect, it } from "vitest";
import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import addIssueNote, { addIssueNoteOutputSchema } from "./add-issue-note.js";

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
          user: { name: "Jane Developer", email: "jane@example.com" },
          dateCreated: "2025-04-14T12:34:56.000Z",
          data: { text: "Investigating after the latest deploy." },
          backendOnlyField: "must-not-leak",
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

    assertStructuredOnlyResult(result);
    const structuredContent = getStructuredContent(result);
    expect(addIssueNote.outputSchema).toBe(addIssueNoteOutputSchema);
    expect(addIssueNoteOutputSchema.parse(structuredContent)).toEqual(
      structuredContent,
    );
    expect(structuredContent).toMatchInlineSnapshot(`
      {
        "issueId": "CLOUDFLARE-MCP-41",
        "issueUrl": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41",
        "note": {
          "author": "Jane Developer (Claude via MCP)",
          "dateCreated": "2025-04-14T12:34:56.000Z",
          "id": "comment-1",
          "text": "Investigating after the latest deploy.",
          "type": "note",
        },
        "organizationSlug": "sentry-mcp-evals",
      }
    `);
    const serialized = JSON.stringify(structuredContent);
    expect(serialized).not.toContain("activity-1");
    expect(serialized).not.toContain("must-not-leak");
    // Author attribution prefers the user name; email is only a fallback.
    expect(serialized).not.toContain("jane@example.com");
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

    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "issueId": "CLOUDFLARE-MCP-41",
        "issueUrl": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41",
        "note": {
          "author": "Test User",
          "dateCreated": "2025-04-14T12:34:56.000Z",
          "id": "12345",
          "text": "Investigating with the payments team.",
          "type": "note",
        },
        "organizationSlug": "sentry-mcp-evals",
      }
    `);
  });
});
