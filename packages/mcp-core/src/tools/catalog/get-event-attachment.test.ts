import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mswServer } from "@sentry/mcp-server-mocks";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import getEventAttachment from "./get-event-attachment.js";

const context = {
  constraints: { organizationSlug: null, projectSlug: null },
  accessToken: "access-token",
  userId: "1",
};

async function downloadMockedAttachment({
  eventId,
  attachmentId,
  filename,
  contentType,
  body,
}: {
  eventId: string;
  attachmentId: string;
  filename: string;
  contentType: string;
  body: string;
}) {
  const attachmentApi = `https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/${eventId}/attachments`;
  const bodyBytes = new TextEncoder().encode(body);

  mswServer.use(
    http.get(`${attachmentApi}/`, () =>
      HttpResponse.json([
        {
          id: attachmentId,
          name: filename,
          type: "event.attachment",
          size: bodyBytes.length,
          mimetype: contentType,
          dateCreated: "2025-04-08T21:15:04.000Z",
        },
      ]),
    ),
    http.get(
      `${attachmentApi}/${attachmentId}/`,
      () =>
        new HttpResponse(bodyBytes, {
          headers: { "Content-Type": contentType },
        }),
    ),
  );

  return await getEventAttachment.handler(
    {
      organizationSlug: "sentry-mcp-evals",
      projectSlug: "cloudflare-mcp",
      eventId,
      attachmentId,
      regionUrl: null,
    },
    context,
  );
}

describe("get_event_attachment", () => {
  it("lists attachments for an event", async () => {
    const result = await getEventAttachment.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        eventId: "7ca573c0f4814912aaa9bdc77d1a7d51",
        attachmentId: null,
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
          projectSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );
    expect(result).toMatchInlineSnapshot(`
      "# Event Attachments

      **Event ID:** 7ca573c0f4814912aaa9bdc77d1a7d51
      **Project:** cloudflare-mcp

      Found 1 attachment(s):

      ## Attachment 1

      **ID:** 123
      **Name:** screenshot.png
      **Type:** event.attachment
      **Size:** 1024 bytes
      **MIME Type:** image/png
      **Created:** 2025-04-08T21:15:04.000Z

      To download this attachment with the attachmentId provided:
      Use the Sentry tool \`get_event_attachment\`

      "
    `);
  });

  it("downloads a specific attachment by ID", async () => {
    const result = await getEventAttachment.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        eventId: "7ca573c0f4814912aaa9bdc77d1a7d51",
        attachmentId: "123",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
          projectSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Should return an array with both text description and image content
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    // First item should be the image content
    expect(result[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: expect.any(String), // base64 encoded data
    });

    // Second item should be the text description
    expect(result[1]).toMatchInlineSnapshot(`
      {
        "text": "# Event Attachment Download

      **Event ID:** 7ca573c0f4814912aaa9bdc77d1a7d51
      **Attachment ID:** 123
      **Filename:** screenshot.png
      **Type:** event.attachment
      **Size:** 1024 bytes
      **MIME Type:** image/png
      **Created:** 2025-04-08T21:15:04.000Z

      **Download URL:** https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/7ca573c0f4814912aaa9bdc77d1a7d51/attachments/123/?download=1

      ## Binary Content

      The attachment is included as a resource and accessible through your client.
      ",
        "type": "text",
      }
    `);
  });

  it("prefers Content-Type from download response over stale metadata mimetype", async () => {
    // Covers the case where the SDK uploaded with application/octet-stream at
    // ingest time (metadata Step 1) but the download endpoint (Step 2) now
    // returns the correct Content-Type after getsentry/sentry#115977, or where
    // the two values simply disagree. The MCP should use Step 2 and render
    // the attachment as an image, not a generic binary resource.
    const result = await getEventAttachment.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        eventId: "d49541c747cb4d8aa3efb70ca5aba244",
        attachmentId: "456",
        regionUrl: null,
      },
      {
        constraints: {
          organizationSlug: null,
          projectSlug: null,
        },
        accessToken: "access-token",
        userId: "1",
      },
    );

    expect(Array.isArray(result)).toBe(true);
    // First item must be an image, not an EmbeddedResource — proving the MCP
    // used image/png from the download Content-Type, not application/octet-stream
    // from the metadata.
    expect(result[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
    });
  });

  it("decodes and inlines a text/plain (.log) attachment", async () => {
    const result = await getEventAttachment.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        eventId: "e49541c747cb4d8aa3efb70ca5aba245",
        attachmentId: "789",
        regionUrl: null,
      },
      {
        constraints: { organizationSlug: null, projectSlug: null },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Text files are inlined as a single text block — no image/resource part.
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "text" });
    const text = (result[0] as { text: string }).text;
    expect(text).toContain("**MIME Type:** text/plain");
    expect(text).toContain("## File Content");
    expect(text).toContain("INFO app started");
    expect(text).toContain("ERROR db connection failed");
  });

  it.each([
    {
      contentType: "application/json",
      filename: "event.json",
      payload: '{"event_id":"abc123","level":"error"}',
    },
    {
      contentType: "application/jsonl",
      filename: "events.jsonl",
      payload: '{"type":"session"}\n{"type":"event","id":"def456"}',
    },
  ])(
    "decodes $contentType as one schema-valid text block with the exact payload",
    async ({ contentType, filename, payload }) => {
      const eventId = "a49541c747cb4d8aa3efb70ca5aba249";
      const attachmentId = "321";
      const result = await downloadMockedAttachment({
        eventId,
        attachmentId,
        filename,
        contentType,
        body: payload,
      });

      expect(result).toEqual([
        {
          type: "text",
          text:
            `# Event Attachment Download\n\n` +
            `**Event ID:** ${eventId}\n` +
            `**Attachment ID:** ${attachmentId}\n` +
            `**Filename:** ${filename}\n` +
            `**Type:** event.attachment\n` +
            `**Size:** ${new TextEncoder().encode(payload).length} bytes\n` +
            `**MIME Type:** ${contentType}\n` +
            `**Created:** 2025-04-08T21:15:04.000Z\n\n` +
            `**Download URL:** https://sentry.io/api/0/projects/sentry-mcp-evals/cloudflare-mcp/events/${eventId}/attachments/${attachmentId}/?download=1\n\n` +
            `## File Content\n\n` +
            `\`\`\`\n${payload}\n\`\`\`\n\n`,
        },
      ]);

      const protocolResult = CallToolResultSchema.parse({ content: result });
      expect(protocolResult.content).toEqual(result);
    },
  );

  it("preserves application/octet-stream as a schema-valid embedded resource", async () => {
    const eventId = "b49541c747cb4d8aa3efb70ca5aba250";
    const result = await downloadMockedAttachment({
      eventId,
      attachmentId: "654",
      filename: "core.dmp",
      contentType: "application/octet-stream",
      body: "\x00\x01binary",
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: "resource",
      resource: {
        uri: "file://core.dmp",
        mimeType: "application/octet-stream",
        blob: "AAFiaW5hcnk=",
      },
    });
    expect(result[1]).toMatchObject({ type: "text" });
    expect((result[1] as { text: string }).text).toContain(
      "## Binary Content\n\nThe attachment is included as a resource and accessible through your client.\n",
    );

    const protocolResult = CallToolResultSchema.parse({ content: result });
    expect(protocolResult.content).toEqual(result);
  });

  it("returns a presigned direct-download URL for an oversized objectstore attachment", async () => {
    const result = await getEventAttachment.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        eventId: "f49541c747cb4d8aa3efb70ca5aba246",
        attachmentId: "999",
        regionUrl: null,
      },
      {
        constraints: { organizationSlug: null, projectSlug: null },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Oversized objectstore: no bytes downloaded; a guidance string leading with
    // the presigned direct link (no auth) is returned.
    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toContain("Too Large to Return Inline");
    expect(text).toContain("50.0 MB");
    expect(text).toContain("30.0 MB");
    expect(text).toContain("Direct download");
    expect(text).toContain("no authentication needed");
    expect(text).toContain(
      "https://objectstore.example.test/attachments/999/blob?sig=test-signature",
    );
    // The authenticated API endpoint is still offered as a fallback.
    expect(text).toContain(
      "sentry api projects/sentry-mcp-evals/cloudflare-mcp/events/f49541c747cb4d8aa3efb70ca5aba246/attachments/999/?download=1",
    );
  });

  it("falls back to authenticated-download instructions for an oversized legacy attachment", async () => {
    const result = await getEventAttachment.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        eventId: "h49541c747cb4d8aa3efb70ca5aba248",
        attachmentId: "222",
        regionUrl: null,
      },
      {
        constraints: { organizationSlug: null, projectSlug: null },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Oversized legacy (no presigned URL): auth-required guidance only.
    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toContain("Too Large to Return Inline");
    expect(text).toContain("40.0 MB");
    expect(text).toContain("requires your Sentry credentials");
    expect(text).not.toContain("objectstore.example.test");

    // The uploader-controlled filename must not be interpolated into the shell
    // command — the redirect target uses the validated attachment ID instead.
    expect(text).toContain(
      "sentry api projects/sentry-mcp-evals/cloudflare-mcp/events/h49541c747cb4d8aa3efb70ca5aba248/attachments/222/?download=1 > attachment-222",
    );
    expect(text).not.toContain("?download=1 > pwn");
  });

  it("flags an empty download body when metadata reports a non-empty file", async () => {
    const result = await getEventAttachment.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        projectSlug: "cloudflare-mcp",
        eventId: "g49541c747cb4d8aa3efb70ca5aba247",
        attachmentId: "111",
        regionUrl: null,
      },
      {
        constraints: { organizationSlug: null, projectSlug: null },
        accessToken: "access-token",
        userId: "1",
      },
    );

    // Zero-byte body: no binary/image part is emitted; the text flags the gap.
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "text" });
    const text = (result[0] as { text: string }).text;
    expect(text).toContain("## Empty Content");
    expect(text).toContain("returned no data");
    expect(text).toContain("1024 bytes");
  });

  it("throws error for malformed regionUrl", async () => {
    await expect(
      getEventAttachment.handler(
        {
          organizationSlug: "sentry-mcp-evals",
          projectSlug: "cloudflare-mcp",
          eventId: "7ca573c0f4814912aaa9bdc77d1a7d51",
          attachmentId: null,
          regionUrl: "https",
        },
        {
          constraints: {
            organizationSlug: null,
            projectSlug: null,
          },
          accessToken: "access-token",
          userId: "1",
        },
      ),
    ).rejects.toThrow("Invalid regionUrl provided. Must be a valid URL.");
  });
});
