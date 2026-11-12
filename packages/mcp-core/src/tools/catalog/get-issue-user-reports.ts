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

type UserReport = UserReportList[number];

function orNull(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

/**
 * Sentry fills display names from the email or username when no real name
 * exists, so treat a name that just repeats one of those as missing.
 */
function realName(
  value: string | null | undefined,
  identities: Array<string | null>,
): string | null {
  const name = orNull(value);
  if (!name) {
    return null;
  }
  const lowered = name.toLowerCase();
  return identities.some((identity) => identity?.toLowerCase() === lowered)
    ? null
    : name;
}

function mapEventUser(user: UserReport["user"]) {
  if (!user) {
    return null;
  }
  const id = orNull(user.id);
  const username = orNull(user.username);
  const email = orNull(user.email);
  const mapped = {
    // Older Sentry serializers can emit sentinel strings when no user ID exists.
    id: id && !["none", "null"].includes(id.toLowerCase()) ? id : null,
    username,
    name: realName(user.name, [email, username]),
    email,
    ipAddress: orNull(user.ipAddress),
  };
  return Object.values(mapped).some((value) => value !== null) ? mapped : null;
}

const eventUserSchema = z
  .object({
    id: z.string().nullable(),
    username: z.string().nullable(),
    name: z
      .string()
      .nullable()
      .describe("Null when Sentry only has an email or username."),
    email: z.string().nullable(),
    ipAddress: z.string().nullable(),
  })
  .nullable()
  .describe("The user on the linked event. Null when the event has none.");

export const getIssueUserReportsOutputSchema = z.object({
  organizationSlug: z.string(),
  issueId: z.string(),
  reports: z.array(
    z.object({
      id: z.string(),
      eventId: z.string(),
      name: z
        .string()
        .nullable()
        .describe(
          "Name the reporter entered, falling back to the event user's name. Null when Sentry only has an email or username.",
        ),
      email: z
        .string()
        .nullable()
        .describe("Email on the report, falling back to the event user."),
      user: eventUserSchema,
      comments: z.string(),
      dateCreated: z.string().nullable(),
    }),
  ),
  nextCursor: z
    .string()
    .nullable()
    .describe("Pass as cursor with the same issue scope for the next page."),
});

function mapUserReport(report: UserReport) {
  const user = mapEventUser(report.user);
  const email = orNull(report.email) ?? user?.email ?? null;
  return {
    id: report.id,
    eventId: report.eventID,
    name:
      realName(report.name, [
        email,
        user?.email ?? null,
        user?.username ?? null,
      ]) ??
      user?.name ??
      null,
    email,
    user,
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
