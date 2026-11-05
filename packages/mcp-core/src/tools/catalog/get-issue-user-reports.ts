import { z } from "zod";
import type { UserReportList } from "../../api-client/types";
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
import { formatDate } from "./support/api-formatting";

function getReporter(report: UserReportList[number]): string {
  const userId = report.user?.id?.trim();
  // Older Sentry serializers can emit sentinel strings when no user ID exists.
  const userIdReporter =
    userId && !["none", "null"].includes(userId.toLowerCase())
      ? `user:${userId}`
      : null;
  return (
    report.name?.trim() ||
    report.email?.trim() ||
    report.user?.name?.trim() ||
    report.user?.email?.trim() ||
    report.user?.username?.trim() ||
    userIdReporter ||
    "anonymous"
  );
}

export const getIssueUserReportsOutputSchema = z.object({
  organizationSlug: z.string(),
  issueId: z.string(),
  reports: z.array(
    z.object({
      id: z.string(),
      eventId: z.string(),
      reporter: z.string(),
      comments: z.string(),
      dateCreated: z.string().nullable(),
    }),
  ),
  nextCursor: z
    .string()
    .nullable()
    .describe("Pass as cursor with the same issue scope for the next page."),
});

function mapUserReport(report: UserReportList[number]) {
  return {
    id: report.id,
    eventId: report.eventID,
    reporter: getReporter(report),
    comments: report.comments,
    dateCreated: formatDate(report.dateCreated),
  };
}

export default defineTool({
  name: "get_issue_user_reports",
  title: "Get Issue User Reports",
  skills: ["inspect", "triage"],
  requiredScopes: ["event:read"],
  description: [
    "Get legacy User Reports or crash-report feedback attached to a Sentry issue.",
    "",
    "Use this tool when you need to:",
    "- See what a user said happened when an error occurred",
    "- Check if any legacy bug reports or crash-report feedback were submitted for this issue",
    "- Get the human-provided context behind a crash, beyond the stack trace",
    "",
    "<examples>",
    "get_issue_user_reports(organizationSlug='my-organization', issueId='PROJECT-123')",
    "get_issue_user_reports(issueUrl='https://my-organization.sentry.io/issues/PROJECT-123/')",
    "</examples>",
    "",
    "<hints>",
    "- For standalone User Feedback Widget submissions, use `search_issues(query='issue.category:feedback')`.",
    "- Reuse pagination cursors only with the same issue scope.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    issueUrl: ParamIssueUrl.optional(),
    cursor: z
      .string()
      .trim()
      .describe("Optional pagination cursor from a previous response.")
      .nullable()
      .default(null),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .describe("Maximum number of user reports to return.")
      .default(25),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: getIssueUserReportsOutputSchema,
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

    const { reports, nextCursor } = await apiService.getIssueUserReports({
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
      cursor: params.cursor,
      limit: params.limit,
    });

    return structuredResult({
      organizationSlug: parsed.organizationSlug,
      issueId: parsed.issueId,
      reports: reports.map(mapUserReport),
      nextCursor: nextCursor ?? null,
    });
  },
});
