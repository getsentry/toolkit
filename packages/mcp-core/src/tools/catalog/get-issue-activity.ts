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

const MAX_DETAILS_LENGTH = 200;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;

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
  assignee: z
    .object({
      id: z.string(),
      type: z.string().nullable(),
      name: z.string().nullable(),
    })
    .optional(),
  version: z.string().optional().describe("Release the issue resolved in."),
  ignore: z
    .object({
      duration: z.number().optional(),
      count: z.number().optional(),
      window: z.number().optional(),
      userCount: z.number().optional(),
      userWindow: z.number().optional(),
      until: z.string().optional(),
      untilEscalating: z.boolean().optional(),
    })
    .optional(),
  commit: z
    .object({
      id: z.string(),
      message: z.string().nullable().describe("First line only."),
      repository: z.string().nullable(),
    })
    .optional(),
  pullRequest: z
    .object({
      id: z.string(),
      title: z.string().nullable(),
      repository: z.string().nullable(),
    })
    .optional(),
  details: z
    .string()
    .nullable()
    .describe(
      `Other activity data as compact JSON without email fields, truncated after ${MAX_DETAILS_LENGTH} characters. Set only when no text or mapped field covers the entry.`,
    ),
});

type IssueActivityEntry = z.infer<typeof issueActivityEntrySchema>;

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

function readNumber(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const field = value[key];
  return typeof field === "number" ? field : undefined;
}

function readRepositoryName(value: Record<string, unknown>): string | null {
  const repository = value.repository;
  return isPlainObject(repository) ? readString(repository, "name") : null;
}

function mapAssignee(data: Record<string, unknown>) {
  const id = data.assignee;
  if (typeof id !== "string" && typeof id !== "number") {
    return undefined;
  }
  return {
    id: formatId(id),
    type: readString(data, "assigneeType"),
    name: readString(data, "assigneeName"),
  };
}

function mapIgnore(data: Record<string, unknown>) {
  const ignore = {
    duration: readNumber(data, "ignoreDuration"),
    count: readNumber(data, "ignoreCount"),
    window: readNumber(data, "ignoreWindow"),
    userCount: readNumber(data, "ignoreUserCount"),
    userWindow: readNumber(data, "ignoreUserWindow"),
    until: readString(data, "ignoreUntil") ?? undefined,
    untilEscalating:
      typeof data.ignoreUntilEscalating === "boolean"
        ? data.ignoreUntilEscalating
        : undefined,
  };
  return Object.values(ignore).some((value) => value !== undefined)
    ? ignore
    : undefined;
}

function mapCommit(data: Record<string, unknown>) {
  const commit = data.commit;
  if (!isPlainObject(commit) || commit.id == null) {
    return undefined;
  }
  return {
    id: formatId(commit.id as string | number),
    message: readString(commit, "message")?.split("\n")[0] ?? null,
    repository: readRepositoryName(commit),
  };
}

function mapPullRequest(data: Record<string, unknown>) {
  const pullRequest = data.pullRequest;
  if (!isPlainObject(pullRequest) || pullRequest.id == null) {
    return undefined;
  }
  return {
    id: formatId(pullRequest.id as string | number),
    title: readString(pullRequest, "title"),
    repository: readRepositoryName(pullRequest),
  };
}

/**
 * Drops email keys and email-looking values at any depth. Commit, pull
 * request, and group payloads embed user objects with email addresses.
 */
function withoutEmails(value: unknown): unknown {
  if (typeof value === "string") {
    return EMAIL_PATTERN.test(value) ? undefined : value;
  }
  if (Array.isArray(value)) {
    return value.map(withoutEmails).filter((item) => item !== undefined);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/email/i.test(key))
        .map(([key, item]) => [key, withoutEmails(item)] as const)
        .filter(([, item]) => item !== undefined),
    );
  }
  return value;
}

function formatDetails(data: Record<string, unknown>): string | null {
  const sanitized = withoutEmails(data) as Record<string, unknown>;
  if (Object.keys(sanitized).length === 0) {
    return null;
  }
  const json = JSON.stringify(sanitized);
  return json.length <= MAX_DETAILS_LENGTH
    ? json
    : `${json.slice(0, MAX_DETAILS_LENGTH)}...`;
}

function mapActivity(
  activity: IssueActivity | IssueComment,
): IssueActivityEntry {
  const text = getActivityText(activity);
  const commentId = activity.commentId;
  const entry: IssueActivityEntry = {
    id: formatId(activity.id),
    type: activity.type ?? "activity",
    author: formatActivityAuthor(activity),
    dateCreated: formatDate(activity.dateCreated),
    commentId:
      commentId != null && String(commentId) !== String(activity.id)
        ? formatId(commentId)
        : null,
    text,
    details: null,
  };

  const data = activity.data;
  if (text || !isPlainObject(data) || Object.keys(data).length === 0) {
    return entry;
  }

  const mapped = {
    assignee: mapAssignee(data),
    version: readString(data, "version") ?? undefined,
    ignore: mapIgnore(data),
    commit: mapCommit(data),
    pullRequest: mapPullRequest(data),
  };
  const present = Object.fromEntries(
    Object.entries(mapped).filter(([, value]) => value !== undefined),
  );
  return Object.keys(present).length > 0
    ? { ...entry, ...present }
    : { ...entry, details: formatDetails(data) };
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
