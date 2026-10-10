import { z } from "zod";
import type { IssueComment } from "../../api-client/types";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  ensureIssueWithinProjectConstraint,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import {
  ParamIssueShortId,
  ParamIssueUrl,
  ParamOrganizationSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  formatActor,
  formatDate,
  formatId,
  readString,
} from "./support/api-formatting";

function formatComment(comment: IssueComment): string {
  const actor = comment.user ? formatActor(comment.user) : "current user";
  const text = comment.data ? readString(comment.data, "text") : null;

  return [
    `**Comment ID**: ${formatId(comment.id)}`,
    `**Type**: ${comment.type ?? "note"}`,
    `**Author**: ${actor}`,
    formatDate(comment.dateCreated)
      ? `**Created**: ${formatDate(comment.dateCreated)}`
      : null,
    text ? `**Text**: ${text}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export default defineTool({
  name: "add_issue_note",
  skills: ["triage"],
  requiredScopes: ["event:write"],
  description: [
    "Add a human-visible comment to a Sentry issue's activity feed.",
    "",
    "Use this tool when the user explicitly asks to leave a note/comment, or when a triage workflow needs to record a user-approved explanation.",
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

    return [
      `# Added Note to Issue ${parsed.issueId} in **${parsed.organizationSlug}**`,
      "",
      formatComment(comment),
      "",
      "## Response Notes",
      "",
      "- The note is visible in the issue activity feed.",
    ].join("\n");
  },
});
