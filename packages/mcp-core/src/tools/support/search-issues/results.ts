import { z } from "zod";
import type { Issue } from "../../../api-client";
import { getSeerActionabilityLabel } from "../../../internal/formatting";
import { structuredResult } from "../../../internal/tool-helpers/results";
import {
  buildSuggestedToolAction,
  type SuggestedToolAction,
  suggestedToolActionSchema,
} from "../../../internal/tool-helpers/suggested-actions";
import { logInfo } from "../../../telem/logging";
import type { SentryProtocol } from "../../../types";
import { getIssueUrl, getIssuesSearchUrl } from "../../../utils/url-utils";
import type { StructuredToolOutput } from "../../types";

const PRESENTATION_HINT =
  "Cards work well for these issues, with status, assignee, and issue ID links visible. Please tell the user this dashboard link is available if they want to open the results in Sentry.";
const EMPTY_NOTE =
  "No issues found matching your search criteria. Try adjusting your search criteria or time range.";

export const ISSUE_SORTS = [
  "date",
  "freq",
  "new",
  "user",
  "recommended",
] as const;

export type IssueSort = (typeof ISSUE_SORTS)[number];

/**
 * The search_issues payload. Issue fields are mapped explicitly, with the
 * names get_issue_details uses, so the passthrough issue schema cannot leak.
 */
export const searchIssuesOutputSchema = z.object({
  query: z.string(),
  explanation: z.string().nullable(),
  executedSearch: z.object({
    query: z.string(),
    sort: z.enum(ISSUE_SORTS),
    period: z.string(),
    projectSlugOrId: z.string().nullable(),
  }),
  url: z.string().describe("Opens these results in Sentry."),
  presentationHint: z.string(),
  notes: z.array(z.string()),
  issues: z.array(
    z.object({
      shortId: z.string(),
      title: z.string(),
      url: z.string(),
      status: z.string(),
      substatus: z.string().nullable(),
      issueCategory: z.string().nullable(),
      occurrences: z.number(),
      usersImpacted: z.number(),
      assignedTo: z.string().nullable(),
      assigneeEmail: z.string().nullable(),
      reporter: z
        .object({
          name: z.string().nullable(),
          email: z.string().nullable(),
        })
        .nullable()
        .describe("Who submitted a feedback issue. Null for other issues."),
      firstSeen: z.string().nullable(),
      lastSeen: z.string().nullable(),
      culprit: z.string().nullable(),
      seerActionability: z.string().nullable(),
      projectSlug: z.string().nullable(),
    }),
  ),
  suggestedActions: z.array(suggestedToolActionSchema),
});

export type SearchIssuesStructuredContent = z.infer<
  typeof searchIssuesOutputSchema
>;

export interface BuildIssueResultsParams {
  issues: Issue[];
  organizationSlug: string;
  inputQuery: string;
  query: string;
  sort: IssueSort;
  period: string;
  projectSlugOrId?: string;
  explanation?: string;
  notes: string[];
  regionUrl?: string;
  host?: string;
  protocol?: SentryProtocol;
  experimentalMode?: boolean;
  availableToolNames?: ReadonlySet<string>;
  directToolNames?: ReadonlySet<string>;
}

function formatAssignee(assignee: Issue["assignedTo"]): string | null {
  if (typeof assignee === "string") {
    return assignee;
  }
  return assignee?.name || null;
}

function formatAssigneeEmail(assignee: Issue["assignedTo"]): string | null {
  return typeof assignee === "object" ? assignee?.email || null : null;
}

function formatReporter(issue: Issue) {
  if (issue.issueCategory !== "feedback") {
    return null;
  }
  const name = issue.metadata?.name || null;
  const email = issue.metadata?.contact_email || null;
  return name || email ? { name, email } : null;
}

/** Builds the structured search_issues result. */
export function buildIssueResults(
  params: BuildIssueResultsParams,
): StructuredToolOutput<SearchIssuesStructuredContent> {
  const { organizationSlug, projectSlugOrId, query } = params;

  const region = params.regionUrl ? new URL(params.regionUrl) : null;
  const host = region?.host || params.host || "sentry.io";
  const protocol =
    (region?.protocol.replace(":", "") as SentryProtocol | undefined) ||
    params.protocol ||
    "https";

  if (params.issues.length === 0) {
    logInfo(`No issues found for query: ${params.inputQuery || query}`, {
      extra: {
        query,
        organizationSlug,
        projectSlug: projectSlugOrId,
        inputQuery: params.inputQuery,
      },
    });
  }

  const issues = params.issues.map((issue) => ({
    shortId: issue.shortId,
    title: issue.title,
    url: getIssueUrl(host, organizationSlug, issue.shortId, protocol),
    status: issue.status,
    substatus: issue.substatus ?? null,
    issueCategory: issue.issueCategory ?? null,
    occurrences: Number(issue.count) || 0,
    usersImpacted: Number(issue.userCount) || 0,
    assignedTo: formatAssignee(issue.assignedTo),
    assigneeEmail: formatAssigneeEmail(issue.assignedTo),
    reporter: formatReporter(issue),
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    culprit: issue.culprit || null,
    seerActionability:
      issue.seerFixabilityScore == null
        ? null
        : getSeerActionabilityLabel(issue.seerFixabilityScore),
    projectSlug: issue.project?.slug ?? null,
  }));

  return structuredResult({
    query: params.inputQuery,
    explanation: params.explanation || null,
    executedSearch: {
      query,
      sort: params.sort,
      period: params.period,
      projectSlugOrId: projectSlugOrId ?? null,
    },
    url: getIssuesSearchUrl(
      host,
      organizationSlug,
      query,
      projectSlugOrId,
      protocol,
    ),
    presentationHint: PRESENTATION_HINT,
    notes: issues.length === 0 ? [...params.notes, EMPTY_NOTE] : params.notes,
    issues,
    suggestedActions: buildIssueActions(issues, params),
  });
}

function buildIssueActions(
  issues: SearchIssuesStructuredContent["issues"],
  params: BuildIssueResultsParams,
): SuggestedToolAction[] {
  const first = issues[0];
  const feedback = issues.find((issue) => issue.issueCategory === "feedback");
  const targets = [
    first && first !== feedback
      ? { issue: first, reason: "Inspect the first matching issue." }
      : null,
    feedback
      ? {
          issue: feedback,
          reason: "Read the full feedback and its linked error events.",
        }
      : null,
  ];
  return targets.flatMap((target) => {
    const action = target
      ? buildSuggestedToolAction({
          toolName: "get_sentry_resource",
          arguments: {
            organizationSlug: params.organizationSlug,
            resourceType: "issue",
            resourceId: target.issue.shortId,
          },
          reason: target.reason,
          experimentalMode: params.experimentalMode ?? false,
          availableToolNames: params.availableToolNames,
          directToolNames: params.directToolNames,
        })
      : null;
    return action ? [action] : [];
  });
}
