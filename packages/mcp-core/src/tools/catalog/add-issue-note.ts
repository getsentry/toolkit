import { z } from "zod";
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
import type { ServerContext } from "../../types";
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
  }),
});

function mapNote(comment: IssueComment) {
  return {
    id: formatId(comment.commentId ?? comment.id),
    type: comment.type ?? "note",
    author: formatActivityAuthor(comment, "current user"),
    dateCreated: formatDate(comment.dateCreated),
    text: comment.data ? readString(comment.data, "text") : null,
  };
}

export default defineTool({
  name: "add_issue_note",
  title: "Add Issue Note",
  skills: ["triage"],
  requiredScopes: ["event:write"],
  description: [
    "Add a comment to a Sentry issue's activity feed.",
    "",
    "Use this tool to record findings, context, or decisions on an issue.",
    "",
    "<examples>",
    "add_issue_note(organizationSlug='my-organization', issueId='PROJECT-123', text='Investigating with the payments team.')",
    "add_issue_note(issueUrl='https://my-organization.sentry.io/issues/PROJECT-123/', text='Resolved by deploy 1.2.3.')",
    "</examples>",
    "",
    "<hints>",
    "- This mutates visible Sentry issue state by posting a comment.",
    "- Do not use this for private scratch notes, secrets, credentials, or unapproved content.",
    "</hints>",
  ].join("\n"),
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
      .describe("The exact comment text to add to the issue."),
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

    const comment = await apiService.createIssueComment({
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
      text: params.text,
    });

    return structuredResult({
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
      issueUrl: apiService.getIssueUrl(parsed.organizationSlug, parsed.issueId),
      note: mapNote(comment),
    });
  },
});
