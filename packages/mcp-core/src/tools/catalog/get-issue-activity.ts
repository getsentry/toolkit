import { z } from "zod";
import type { IssueActivity, IssueComment } from "../../api-client/types";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  ensureIssueWithinProjectConstraint,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import { formatAvailableToolCallInstruction } from "../../internal/tool-helpers/tool-call-formatting";
import { isPlainObject } from "../../internal/type-guards";
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
  formatUnknown,
  readString,
} from "./support/api-formatting";

function getActivityText(
  activity: IssueActivity | IssueComment,
): string | null {
  const data = activity.data;
  if (!data) {
    return null;
  }

  return (
    readString(data, "text") ??
    readString(data, "message") ??
    readString(data, "reason") ??
    readString(data, "description")
  );
}

function formatActivity(activity: IssueActivity | IssueComment): string {
  const actor = activity.user ? formatActor(activity.user) : "system";
  const date = formatDate(activity.dateCreated) ?? "unknown time";
  const text = getActivityText(activity);
  const details =
    !text &&
    isPlainObject(activity.data) &&
    Object.keys(activity.data).length > 0
      ? `\n  - Data: ${formatUnknown(activity.data)}`
      : "";
  return `- ${date}: ${activity.type ?? "activity"} by ${actor} (${formatId(activity.id)})${text ? `\n  - ${text}` : ""}${details}`;
}

export default defineTool({
  name: "get_issue_activity",
  skills: ["inspect", "triage"],
  requiredScopes: ["event:read"],
  description: [
    "Get the activity feed and comments for a Sentry issue.",
    "",
    "Use this tool when you need to:",
    "- Review prior comments before triaging an issue",
    "- Understand who resolved, ignored, assigned, or commented on an issue",
    "- See recent issue activity that is not included in `get_issue_details`",
    "",
    "<examples>",
    "get_issue_activity(organizationSlug='my-organization', issueId='PROJECT-123')",
    "get_issue_activity(issueUrl='https://my-organization.sentry.io/issues/PROJECT-123/')",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    issueUrl: ParamIssueUrl.optional(),
    includeComments: z.boolean().default(true),
    limit: z.number().int().positive().max(100).default(25),
  },
  annotations: {
    readOnlyHint: true,
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

    const [activity, comments] = await Promise.all([
      apiService.getIssueActivity({
        organizationSlug: parsed.organizationSlug,
        issueId: parsed.issueId,
      }),
      params.includeComments
        ? apiService.listIssueComments({
            organizationSlug: parsed.organizationSlug,
            issueId: parsed.issueId,
            limit: params.limit,
          })
        : Promise.resolve([]),
    ]);

    const output = [
      `# Activity for Issue ${parsed.issueId} in **${parsed.organizationSlug}**`,
      "",
      "## Activity",
      "",
      activity.length === 0
        ? "No activity found."
        : activity.slice(0, params.limit).map(formatActivity).join("\n"),
    ];

    if (params.includeComments) {
      output.push("", "## Comments", "");
      output.push(
        comments.length === 0
          ? "No comments found."
          : comments.slice(0, params.limit).map(formatActivity).join("\n"),
      );
    }

    const addNoteInstruction = formatAvailableToolCallInstruction({
      toolName: "add_issue_note",
      experimentalMode: context.experimentalMode ?? false,
      availableToolNames: context.availableToolNames,
      directToolNames: context.directToolNames,
      purpose: "to add a new human-visible issue comment",
    });
    if (addNoteInstruction) {
      output.push("", "## Response Notes", "");
      output.push(`- ${addNoteInstruction}.`);
    }

    return `${output.join("\n")}\n`;
  },
});
