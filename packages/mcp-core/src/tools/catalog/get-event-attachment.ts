import type {
  EmbeddedResource,
  ImageContent,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_MAX_INLINE_ATTACHMENT_BYTES } from "../../api-client";
import { bytesToBase64 } from "../../internal/blob-utils";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { formatToolCallInstruction } from "../../internal/tool-helpers/tool-call-formatting";
import {
  ParamAttachmentId,
  ParamEventId,
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render the response for an attachment too large to inline: a presigned direct
 * link when available, otherwise authenticated-download instructions.
 */
function formatOversizedAttachment(
  params: {
    organizationSlug: string;
    projectSlug: string;
    eventId: string;
    attachmentId: string;
  },
  attachment: {
    downloadUrl: string;
    directDownloadUrl: string | null;
    filename: string;
    contentType: string;
    attachment: { type: string; size: number; dateCreated: string };
  },
): string {
  const sizeBytes = attachment.attachment.size;
  const downloadApiPath = `projects/${params.organizationSlug}/${params.projectSlug}/events/${params.eventId}/attachments/${params.attachmentId}/?download=1`;
  // Use the validated attachment ID (not the uploader-controlled filename) as the
  // output name so the command examples can't carry shell metacharacters.
  const outputName = `attachment-${params.attachmentId}`;

  let output = "# Event Attachment — Too Large to Return Inline\n\n";
  output += `**Event ID:** ${params.eventId}\n`;
  output += `**Attachment ID:** ${params.attachmentId}\n`;
  output += `**Filename:** ${attachment.filename}\n`;
  output += `**Type:** ${attachment.attachment.type}\n`;
  output += `**Size:** ${sizeBytes} bytes (${formatMegabytes(sizeBytes)})\n`;
  output += `**MIME Type:** ${attachment.contentType}\n`;
  output += `**Created:** ${attachment.attachment.dateCreated}\n\n`;
  output += `This attachment (${formatMegabytes(sizeBytes)}) exceeds the ${formatMegabytes(
    DEFAULT_MAX_INLINE_ATTACHMENT_BYTES,
  )} inline limit for MCP responses, so its contents were not downloaded.\n\n`;
  output += "## How to download it\n\n";

  if (attachment.directDownloadUrl) {
    output +=
      "**Direct download** (a presigned link — no authentication needed; it expires shortly, so fetch it promptly):\n\n";
    output += `${attachment.directDownloadUrl}\n\n`;
    output +=
      "If the link has expired, re-run this tool to get a fresh one, or use the authenticated API endpoint below.\n\n";
    output +=
      "**Authenticated Sentry API endpoint** (requires Sentry credentials):\n";
    output += `- Sentry CLI: \`sentry api ${downloadApiPath} > ${outputName}\`\n`;
    output += `- Or an \`Authorization: Bearer <token>\` request to: ${attachment.downloadUrl}\n`;
  } else {
    output +=
      "The download URL is an authenticated Sentry API endpoint — it is not a public link and requires your Sentry credentials (a bare fetch returns HTTP 401).\n\n";
    output += "- **Sentry CLI** (handles auth automatically):\n";
    output += `  \`sentry api ${downloadApiPath} > ${outputName}\`\n`;
    output += `- **Any HTTP client** with an \`Authorization: Bearer <token>\` header against: ${attachment.downloadUrl}\n`;
    output += "- **Sentry UI:** open the event and use the Attachments tab.\n";
  }
  return output;
}

export default defineTool({
  name: "get_event_attachment",
  skills: ["inspect"], // Only available in inspect skill
  requiredScopes: ["event:read"],
  description: [
    "Download attachments from a Sentry event.",
    "",
    "Use this tool when you need to:",
    "- Download files attached to a specific event",
    "- Access screenshots, log files, or other attachments uploaded with an error report",
    "- Retrieve attachment metadata and download URLs",
    "",
    "<examples>",
    "### Download a specific attachment by ID",
    "",
    "```",
    "get_event_attachment(organizationSlug='my-organization', projectSlug='my-project', eventId='c49541c747cb4d8aa3efb70ca5aba243', attachmentId='12345')",
    "```",
    "",
    "### List all attachments for an event",
    "",
    "```",
    "get_event_attachment(organizationSlug='my-organization', projectSlug='my-project', eventId='c49541c747cb4d8aa3efb70ca5aba243')",
    "```",
    "",
    "</examples>",
    "",
    "<hints>",
    "- If `attachmentId` is provided, the specific attachment will be downloaded as an embedded resource",
    "- If `attachmentId` is omitted, all attachments for the event will be listed with download information",
    "- The `projectSlug` is required to identify which project the event belongs to",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    projectSlug: ParamProjectSlug,
    eventId: ParamEventId,
    attachmentId: ParamAttachmentId.nullable().default(null),
    regionUrl: ParamRegionUrl.nullable().default(null),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });

    setTargetTagsAndAttributes(params);

    // If attachmentId is provided, download the specific attachment
    if (params.attachmentId) {
      const attachment = await apiService.getEventAttachment({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        eventId: params.eventId,
        attachmentId: params.attachmentId,
      });

      // Too large to inline — return download instructions instead of the bytes.
      if (attachment.bytes === null) {
        return formatOversizedAttachment(
          {
            organizationSlug: params.organizationSlug,
            projectSlug: params.projectSlug,
            eventId: params.eventId,
            attachmentId: params.attachmentId,
          },
          attachment,
        );
      }

      const contentParts: (TextContent | ImageContent | EmbeddedResource)[] =
        [];
      // Use Content-Type from the download response (Step 2) rather than
      // mimetype from the metadata endpoint (Step 1). The two can disagree —
      // notably the JS RN SDK uploads attachments as "application/octet-stream"
      // even when the file is an image — and Step 2 is the authoritative signal.
      const effectiveMimeType = attachment.contentType;
      const isBinary = !effectiveMimeType.startsWith("text/");
      // A zero-byte body for a non-empty file means a failed/truncated download.
      const isEmpty = attachment.bytes.length === 0;

      if (isBinary && !isEmpty) {
        const isImage = effectiveMimeType.startsWith("image/");
        const base64 = bytesToBase64(attachment.bytes);
        if (isImage) {
          const image: ImageContent = {
            type: "image",
            mimeType: effectiveMimeType,
            data: base64,
          };
          contentParts.push(image);
        } else {
          const resource: EmbeddedResource = {
            type: "resource",
            resource: {
              uri: `file://${attachment.filename}`,
              mimeType: effectiveMimeType,
              blob: base64,
            },
          };
          contentParts.push(resource);
        }
      }

      let output = `# Event Attachment Download\n\n`;
      output += `**Event ID:** ${params.eventId}\n`;
      output += `**Attachment ID:** ${params.attachmentId}\n`;
      output += `**Filename:** ${attachment.filename}\n`;
      output += `**Type:** ${attachment.attachment.type}\n`;
      output += `**Size:** ${attachment.attachment.size} bytes\n`;
      output += `**MIME Type:** ${effectiveMimeType}\n`;
      output += `**Created:** ${attachment.attachment.dateCreated}\n\n`;
      output += `**Download URL:** ${attachment.downloadUrl}\n\n`;

      if (isEmpty) {
        output += `## Empty Content\n\n`;
        if (attachment.attachment.size > 0) {
          output += `The download returned no data even though the attachment metadata reports ${attachment.attachment.size} bytes. This usually indicates a failed or truncated download; try again, or download it directly from the URL above (requires Sentry authentication).\n`;
        } else {
          output += `This attachment is empty (0 bytes).\n`;
        }
      } else if (isBinary) {
        output += `## Binary Content\n\n`;
        output += `The attachment is included as a resource and accessible through your client.\n`;
      } else {
        // Text file: inline the decoded content.
        const textContent = new TextDecoder().decode(attachment.bytes);
        output += `## File Content\n\n`;
        output += `\`\`\`\n${textContent}\n\`\`\`\n\n`;
      }

      const text: TextContent = {
        type: "text",
        text: output,
      };
      contentParts.push(text);

      return contentParts;
    }

    // List all attachments for the event
    const attachments = await apiService.listEventAttachments({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectSlug,
      eventId: params.eventId,
    });

    let output = `# Event Attachments\n\n`;
    output += `**Event ID:** ${params.eventId}\n`;
    output += `**Project:** ${params.projectSlug}\n\n`;

    if (attachments.length === 0) {
      output += "No attachments found for this event.\n";
      return output;
    }

    output += `Found ${attachments.length} attachment(s):\n\n`;

    attachments.forEach((attachment, index) => {
      output += `## Attachment ${index + 1}\n\n`;
      output += `**ID:** ${attachment.id}\n`;
      output += `**Name:** ${attachment.name}\n`;
      output += `**Type:** ${attachment.type}\n`;
      output += `**Size:** ${attachment.size} bytes\n`;
      output += `**MIME Type:** ${attachment.mimetype}\n`;
      output += `**Created:** ${attachment.dateCreated}\n\n`;
      output += "To download this attachment with the attachmentId provided:\n";
      output += `${formatToolCallInstruction({
        toolName: "get_event_attachment",
        arguments: {
          organizationSlug: params.organizationSlug,
          projectSlug: params.projectSlug,
          eventId: params.eventId,
          attachmentId: attachment.id,
        },
        experimentalMode: context.experimentalMode ?? false,
        availableToolNames: context.availableToolNames,
        directToolNames: context.directToolNames,
      })}\n\n`;
    });

    return output;
  },
});
