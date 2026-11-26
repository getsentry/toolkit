import { afterEach, assert, describe, expect, it } from "vitest";
import { mswServer } from "@sentry/mcp-server-mocks";
import { http, HttpResponse } from "msw";
import {
  assertStructuredOnlyResult,
  getStructuredContent,
} from "../../test-utils/structured-content.js";
import { UserInputError } from "../../errors.js";
import type { LocalFile } from "../../types.js";
import addIssueNote, { addIssueNoteOutputSchema } from "./add-issue-note.js";

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69]);
const ATTACHMENTS_PATH =
  "*/api/0/organizations/:org/issues/:issueId/comment-attachments/";

function localFiles(files: Record<string, LocalFile>) {
  return async (path: string) => {
    const file = files[path];
    if (!file) {
      throw new UserInputError(`No such file: ${path}`);
    }
    return file;
  };
}

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
          "attachments": [],
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
          "attachments": [],
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

  it("uploads local videos and links them in the note", async () => {
    const uploads: Array<{ name: string; type: string; size: number }> = [];
    let postedText: unknown;
    mswServer.use(
      http.post(ATTACHMENTS_PATH, async ({ request, params }) => {
        const file = (await request.formData()).get("file");
        assert(file instanceof File);
        uploads.push({ name: file.name, type: file.type, size: file.size });
        return HttpResponse.json(
          {
            id: String(uploads.length),
            name: file.name,
            size: file.size,
            contentType: file.type,
            url: `/api/0/organizations/${String(params["org"])}/issues/${String(params["issueId"])}/comment-attachments/${uploads.length}/`,
          },
          { status: 201 },
        );
      }),
      http.post(
        "*/api/0/organizations/:org/issues/:issueId/notes/",
        async ({ request }) => {
          postedText = ((await request.json()) as { text: unknown }).text;
          return HttpResponse.json({
            id: "activity-2",
            commentId: "comment-2",
            type: "note",
            user: { name: "Jane Developer" },
            dateCreated: "2025-04-14T12:34:56.000Z",
            data: { text: postedText },
          });
        },
      ),
    );

    const result = await addIssueNote.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        issueId: "CLOUDFLARE-MCP-41",
        text: "Screen recording of the crash.",
        attachmentPaths: ["/tmp/repro.mp4", "/tmp/take2.mov"],
      },
      {
        ...context,
        readLocalFile: localFiles({
          "/tmp/repro.mp4": { name: "repro.mp4", data: MP4 },
          "/tmp/take2.mov": { name: "take2.mov", data: MP4 },
        }),
      },
    );

    expect(uploads).toEqual([
      { name: "repro.mp4", type: "video/mp4", size: MP4.length },
      { name: "take2.mov", type: "video/quicktime", size: MP4.length },
    ]);
    expect(postedText).toBe(
      "Screen recording of the crash.\n" +
        "[repro.mp4](/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/comment-attachments/1/)\n" +
        "[take2.mov](/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/comment-attachments/2/)",
    );
    expect(getStructuredContent(result)).toMatchInlineSnapshot(`
      {
        "issueId": "CLOUDFLARE-MCP-41",
        "issueUrl": "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41",
        "note": {
          "attachments": [
            {
              "id": "1",
              "name": "repro.mp4",
              "url": "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/comment-attachments/1/",
            },
            {
              "id": "2",
              "name": "take2.mov",
              "url": "https://sentry.io/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/comment-attachments/2/",
            },
          ],
          "author": "Jane Developer",
          "dateCreated": "2025-04-14T12:34:56.000Z",
          "id": "comment-2",
          "text": "Screen recording of the crash.
      [repro.mp4](/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/comment-attachments/1/)
      [take2.mov](/api/0/organizations/sentry-mcp-evals/issues/CLOUDFLARE-MCP-41/comment-attachments/2/)",
          "type": "note",
        },
        "organizationSlug": "sentry-mcp-evals",
      }
    `);
  });

  it("refuses files that are not videos before uploading anything", async () => {
    let uploaded = false;
    mswServer.use(
      http.post(ATTACHMENTS_PATH, () => {
        uploaded = true;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await expect(
      addIssueNote.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          issueId: "CLOUDFLARE-MCP-41",
          text: "Recording attached.",
          attachmentPaths: ["/tmp/repro.mp4", "/home/me/.ssh/id_rsa.mp4"],
        },
        {
          ...context,
          readLocalFile: localFiles({
            "/tmp/repro.mp4": { name: "repro.mp4", data: MP4 },
            "/home/me/.ssh/id_rsa.mp4": {
              name: "id_rsa.mp4",
              data: new TextEncoder().encode("-----BEGIN OPENSSH PRIVATE KEY"),
            },
          }),
        },
      ),
    ).rejects.toThrow("id_rsa.mp4 is not a supported video");
    expect(uploaded).toBe(false);
  });

  it("explains that the hosted server cannot attach local videos", async () => {
    await expect(
      addIssueNote.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          issueId: "CLOUDFLARE-MCP-41",
          text: "Recording attached.",
          attachmentPaths: ["/tmp/repro.mp4"],
        },
        context,
      ),
    ).rejects.toThrow(UserInputError);
  });

  it("surfaces Sentry's size limit when an upload is too large", async () => {
    mswServer.use(
      http.post(ATTACHMENTS_PATH, () =>
        HttpResponse.json(
          { detail: "File is too large. The maximum size is 100 MB." },
          { status: 413 },
        ),
      ),
    );

    await expect(
      addIssueNote.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          regionUrl: null,
          issueId: "CLOUDFLARE-MCP-41",
          text: "Recording attached.",
          attachmentPaths: ["/tmp/repro.mp4"],
        },
        {
          ...context,
          readLocalFile: localFiles({
            "/tmp/repro.mp4": { name: "repro.mp4", data: MP4 },
          }),
        },
      ),
    ).rejects.toThrow("File is too large. The maximum size is 100 MB.");
  });
});
