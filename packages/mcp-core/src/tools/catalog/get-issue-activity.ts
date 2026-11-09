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
    readString(data, "description") ??
    // Seer root cause and solution activities carry a one-line summary.
    readString(data, "summary")
  );
}

const gitAuthorSchema = z
  .object({
    name: z.string().nullable(),
    email: z.string().nullable(),
  })
  .nullable();

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
      email: z.string().nullable(),
    })
    .optional(),
  version: z
    .string()
    .optional()
    .describe(
      "Release version referenced by the activity (resolved-in or regressed-in).",
    ),
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
      author: gitAuthorSchema,
    })
    .nullable()
    .optional()
    .describe("Null when the linked commit was deleted."),
  pullRequest: z
    .object({
      id: z.string(),
      title: z.string().nullable(),
      repository: z.string().nullable(),
      author: gitAuthorSchema,
    })
    .nullable()
    .optional()
    .describe("Null when the linked pull request was deleted."),
  pullRequestUrls: z
    .array(z.string())
    .optional()
    .describe("Pull requests Seer opened."),
  unmerge: z
    .object({
      fingerprintCount: z.number(),
      source: z.object({ shortId: z.string() }).nullable(),
      destination: z.object({ shortId: z.string() }).nullable(),
    })
    .optional(),
  externalIssue: z
    .object({
      title: z.string().nullable(),
      provider: z.string().nullable(),
      location: z.string().nullable(),
    })
    .optional()
    .describe("Issue created in an external tracker."),
  age: z
    .number()
    .optional()
    .describe("Hours without events before the issue was auto-resolved."),
  afterDays: z
    .number()
    .optional()
    .describe("Days after which the issue was automatically marked ongoing."),
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
    email: readString(data, "assigneeEmail"),
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

function readGitAuthor(value: Record<string, unknown>) {
  const author = value.author;
  if (!isPlainObject(author)) {
    return null;
  }
  const name = readString(author, "name");
  const email = readString(author, "email");
  return name || email ? { name, email } : null;
}

function mapCommit(data: Record<string, unknown>) {
  const commit = data.commit;
  if (commit === null) {
    return null;
  }
  if (!isPlainObject(commit) || commit.id == null) {
    return undefined;
  }
  return {
    id: formatId(commit.id as string | number),
    message: readString(commit, "message")?.split("\n")[0]?.trim() || null,
    repository: readRepositoryName(commit),
    author: readGitAuthor(commit),
  };
}

function mapPullRequest(data: Record<string, unknown>) {
  const pullRequest = data.pullRequest;
  if (pullRequest === null) {
    return null;
  }
  if (!isPlainObject(pullRequest) || pullRequest.id == null) {
    return undefined;
  }
  return {
    id: formatId(pullRequest.id as string | number),
    title: readString(pullRequest, "title"),
    repository: readRepositoryName(pullRequest),
    author: readGitAuthor(pullRequest),
  };
}

function mapSeerPullRequestUrls(data: Record<string, unknown>) {
  const pullRequests = data.pull_requests;
  if (!Array.isArray(pullRequests)) {
    return undefined;
  }
  const urls = pullRequests.flatMap((item) => {
    const pullRequest = isPlainObject(item) ? item.pull_request : null;
    const url = isPlainObject(pullRequest)
      ? readString(pullRequest, "pr_url")
      : null;
    return url ? [url] : [];
  });
  return urls.length > 0 ? urls : undefined;
}

function readShortId(value: unknown) {
  const shortId = isPlainObject(value) ? readString(value, "shortId") : null;
  return shortId ? { shortId } : null;
}

function mapUnmerge(type: string, data: Record<string, unknown>) {
  if (type !== "unmerge_source" && type !== "unmerge_destination") {
    return undefined;
  }
  return {
    fingerprintCount: Array.isArray(data.fingerprints)
      ? data.fingerprints.length
      : 0,
    source: readShortId(data.source),
    destination: readShortId(data.destination),
  };
}

function mapExternalIssue(type: string, data: Record<string, unknown>) {
  if (type !== "create_issue") {
    return undefined;
  }
  return {
    title: readString(data, "title"),
    provider: readString(data, "provider"),
    location: readString(data, "location"),
  };
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
  };

  const data = activity.data;
  if (text || !isPlainObject(data) || Object.keys(data).length === 0) {
    return entry;
  }

  // Map known activity data explicitly. Raw data can carry share tokens,
  // integration ids, and Seer run ids, so anything else stays out.
  const type = entry.type;
  const mapped = {
    assignee: mapAssignee(data),
    version: readString(data, "version") ?? undefined,
    ignore: mapIgnore(data),
    commit: mapCommit(data),
    pullRequest: mapPullRequest(data),
    pullRequestUrls: mapSeerPullRequestUrls(data),
    unmerge: mapUnmerge(type, data),
    externalIssue: mapExternalIssue(type, data),
    age: type === "set_resolved_by_age" ? readNumber(data, "age") : undefined,
    afterDays:
      type === "auto_set_ongoing" ? readNumber(data, "after_days") : undefined,
  };
  return {
    ...entry,
    ...Object.fromEntries(
      Object.entries(mapped).filter(([, value]) => value !== undefined),
    ),
  };
}

export default defineTool({
  name: "get_issue_activity",
  title: "Get Issue Activity",
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
