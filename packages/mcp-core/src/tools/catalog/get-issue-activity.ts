import { z } from "zod";
import type { IssueActivity, IssueComment } from "../../api-client/types";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  ensureIssueWithinProjectConstraint,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import { structuredResult } from "../../internal/tool-helpers/results";
import { isPlainObject } from "../../internal/type-guards";
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

const issueActivityEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  author: z.string(),
  dateCreated: z.string().nullable(),
  commentId: z
    .string()
    .nullable()
    .describe("Set when the comment ID differs from the activity ID."),
  text: z.string().nullable(),
  data: z
    .record(z.string(), z.unknown())
    .nullable()
    .describe("Type-specific activity data, set only when there is no text."),
});

export const getIssueActivityOutputSchema = z.object({
  organizationSlug: z.string(),
  issueId: z.string(),
  issueUrl: z.string(),
  activity: z.array(issueActivityEntrySchema),
  comments: z
    .array(issueActivityEntrySchema)
    .nullable()
    .describe("Null when includeComments is false."),
});

function mapActivity(activity: IssueActivity | IssueComment) {
  const text = getActivityText(activity);
  const commentId = activity.commentId;
  return {
    id: formatId(activity.id),
    type: activity.type ?? "activity",
    author: formatActivityAuthor(activity),
    dateCreated: formatDate(activity.dateCreated),
    commentId:
      commentId != null && String(commentId) !== String(activity.id)
        ? formatId(commentId)
        : null,
    text,
    data:
      !text &&
      isPlainObject(activity.data) &&
      Object.keys(activity.data).length > 0
        ? activity.data
        : null,
  };
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
  outputSchema: getIssueActivityOutputSchema,
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

    return structuredResult({
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
      issueUrl: apiService.getIssueUrl(parsed.organizationSlug, parsed.issueId),
      activity: activity.slice(0, params.limit).map(mapActivity),
      comments: params.includeComments
        ? comments.slice(0, params.limit).map(mapActivity)
        : null,
    });
  },
});
