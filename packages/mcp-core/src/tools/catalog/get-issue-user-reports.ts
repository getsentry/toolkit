import { z } from "zod";
import type { UserReportList } from "../../api-client/types";
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

function formatUserReport(report: UserReportList[number]): string {
  const date = formatDate(report.dateCreated) ?? "unknown time";
  const reporter = getReporter(report);
  return `- ${date} by ${reporter}:\n  - "${report.comments}"`;
}

export default defineTool({
  name: "get_issue_user_reports",
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

    const output = [
      `# Issue User Reports for Issue ${parsed.issueId} in **${parsed.organizationSlug}**`,
      "",
      reports.length === 0
        ? "No issue user reports found for this issue."
        : reports.map(formatUserReport).join("\n"),
    ];

    if (nextCursor) {
      output.push(
        "",
        "## Response Notes",
        "",
        `- More user reports are available. Pass \`cursor: "${nextCursor}"\` with the same issue scope to fetch the next page.`,
      );
    }

    return `${output.join("\n")}\n`;
  },
});
