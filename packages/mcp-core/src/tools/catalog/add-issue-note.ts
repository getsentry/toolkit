import { z } from "zod";
import type { IssueCommentAttachment } from "../../api-client/types";
import {
  appendCommentAttachments,
  COMMENT_ATTACHMENT_EXTENSIONS,
  commentAttachmentContentType,
  commentAttachmentPath,
  parseCommentAttachments,
} from "../../comment-attachments";
import { UserInputError } from "../../errors";
import type { IssueComment } from "../../api-client/types";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  ensureIssueWithinProjectConstraint,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamIssueShortId,
  ParamIssueUrl,
  ParamOrganizationSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { LocalFile, LocalFileReader, ServerContext } from "../../types";
import { formatDate, formatId, readString } from "./support/api-formatting";
import { formatActivityAuthor } from "./support/activity-formatting";

export const addIssueNoteOutputSchema = z.object({
  organizationSlug: z.string(),
  issueId: z.string(),
  issueUrl: z.string(),
  note: z.object({
    id: z.string(),
    type: z.string(),
    author: z.string(),
    dateCreated: z.string().nullable(),
    text: z.string().nullable(),
    attachments: z
      .array(z.object({ id: z.string(), name: z.string(), url: z.string() }))
      .describe("Videos uploaded with the note and linked from its text."),
  }),
});

/** Most videos one note can carry. */
const MAX_ATTACHMENTS = 5;

/**
 * Reads each path and checks it is a video before anything is uploaded, so a
 * bad path never leaves a half-uploaded note.
 */
async function readVideos(
  paths: readonly string[],
  readLocalFile: LocalFileReader | undefined,
) {
  if (!readLocalFile) {
    throw new UserInputError(
      "Attaching videos needs the local MCP server (`sentry mcp`), which can read files on this machine. This server cannot.",
    );
  }
  return await Promise.all(
    paths.map(async (path) => {
      let file: LocalFile;
      try {
        file = await readLocalFile(path);
      } catch (error) {
        throw new UserInputError(
          `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const contentType = commentAttachmentContentType(file.name, file.data);
      if (!contentType) {
        throw new UserInputError(
          `${file.name} is not a supported video. Attach ${COMMENT_ATTACHMENT_EXTENSIONS.join(", ")} files.`,
        );
      }
      return { ...file, contentType };
    }),
  );
}

function mapNote(
  comment: IssueComment,
  attachmentUrl: (attachmentId: string) => string,
) {
  const text = comment.data ? readString(comment.data, "text") : null;
  return {
    id: formatId(comment.commentId ?? comment.id),
    type: comment.type ?? "note",
    author: formatActivityAuthor(comment, "current user"),
    dateCreated: formatDate(comment.dateCreated),
    text,
    attachments: parseCommentAttachments(text).map((link) => ({
      id: link.id,
      name: link.name,
      url: attachmentUrl(link.id),
    })),
  };
}

export default defineTool({
  name: "add_issue_note",
  title: "Add Issue Note",
  skills: ["triage"],
  requiredScopes: ["event:write"],
  description:
    "Add a comment (note) to a Sentry issue's activity feed, visible to the whole team. Use it to record findings or decisions; never post secrets or credentials.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    issueUrl: ParamIssueUrl.optional(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .describe(
        "The comment text, posted as is. Links to attached videos are added after it.",
      ),
    attachmentPaths: z
      .array(z.string().trim().min(1))
      .max(MAX_ATTACHMENTS)
      .optional()
      .describe(
        "Local paths of videos to attach (MP4, MOV, WebM or Ogg), such as a screen recording of the bug. Only works when the MCP server runs on the user's machine (`sentry mcp`), and only for files in the directory it was started in. Only attach files the user asked for.",
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: addIssueNoteOutputSchema,
  async handler(params, context: ServerContext) {
    const parsed = parseIssueParams({
      issueUrl: params.issueUrl,
      issueId: params.issueId,
      organizationSlug:
        params.organizationSlug ?? context.constraints.organizationSlug,
    });

    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? context.constraints.regionUrl ?? undefined,
    });
    setTargetTagsAndAttributes({
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
    });

    await ensureIssueWithinProjectConstraint({
      apiService,
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
      projectSlug: context.constraints.projectSlug,
    });

    const videos = params.attachmentPaths?.length
      ? await readVideos(params.attachmentPaths, context.readLocalFile)
      : [];
    const uploaded: IssueCommentAttachment[] = [];
    for (const video of videos) {
      uploaded.push(
        await apiService.uploadIssueCommentAttachment({
          organizationSlug: parsed.organizationSlug,
          issueId: parsed.issueId,
          fileName: video.name,
          contentType: video.contentType,
          data: video.data,
        }),
      );
    }

    const comment = await apiService.createIssueComment({
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
      text: appendCommentAttachments(params.text, uploaded),
    });

    return structuredResult({
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
      issueUrl: apiService.getIssueUrl(parsed.organizationSlug, parsed.issueId),
      note: mapNote(comment, (attachmentId) =>
        apiService.getAbsoluteApiUrl(
          commentAttachmentPath(
            parsed.organizationSlug,
            parsed.issueId,
            attachmentId,
          ),
        ),
      ),
    });
  },
});
