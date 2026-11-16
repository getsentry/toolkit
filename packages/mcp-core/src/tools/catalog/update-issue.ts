import { z } from "zod";
import type {
  AssignedTo,
  Issue,
  IssueActivityList,
  IssueResolutionDetails,
} from "../../api-client/types";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { formatAssignedTo } from "../../internal/tool-helpers/formatting";
import {
  assertIssueWithinProjectConstraint,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamAssignedTo,
  ParamIgnoreCount,
  ParamIgnoreDurationMinutes,
  ParamIgnoreUserCount,
  ParamIgnoreUserWindowMinutes,
  ParamIgnoreWindowMinutes,
  ParamInCommit,
  ParamInCommitRepository,
  ParamInRelease,
  ParamIssueIgnoreMode,
  ParamIssuePriority,
  ParamIssueShortId,
  ParamIssueStatus,
  ParamIssueUrl,
  ParamOrganizationSlug,
  ParamReason,
  ParamRegionUrl,
} from "../../schema";
import { ApiClientError, ApiValidationError } from "@sentry/api/client";
import { logIssue } from "../../telem/logging";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

type IgnoreMode =
  | "untilEscalating"
  | "forever"
  | "forDuration"
  | "untilOccurrenceCount"
  | "untilUserCount";

type IgnoreFamily = "untilEscalating" | "forever" | "condition";

type IgnoreUpdate = {
  substatus:
    | "archived_until_escalating"
    | "archived_forever"
    | "archived_until_condition_met";
  ignoreDuration?: number;
  ignoreCount?: number;
  ignoreWindow?: number;
  ignoreUserCount?: number;
  ignoreUserWindow?: number;
  behavior: string;
  message: string;
};

type IgnoreState = {
  family: IgnoreFamily;
  behavior: string;
  message: string;
};

// `string & {}` keeps the known literals in autocomplete without collapsing
// the union to plain `string`.
type IssueStatusDisplay =
  | "resolved"
  | "resolvedInNextRelease"
  | "resolvedInRelease"
  | "resolvedInCommit"
  | "unresolved"
  | "ignored"
  | (string & {});

type IgnoreParams = {
  status?: string;
  ignoreMode?: IgnoreMode;
  ignoreDurationMinutes?: number;
  ignoreCount?: number;
  ignoreWindowMinutes?: number;
  ignoreUserCount?: number;
  ignoreUserWindowMinutes?: number;
};

function pluralize(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function hasExplicitIgnoreChange(params: IgnoreParams): boolean {
  return (
    params.ignoreMode !== undefined ||
    params.ignoreDurationMinutes !== undefined ||
    params.ignoreCount !== undefined ||
    params.ignoreWindowMinutes !== undefined ||
    params.ignoreUserCount !== undefined ||
    params.ignoreUserWindowMinutes !== undefined
  );
}

function inferIgnoreMode(params: IgnoreParams): IgnoreMode {
  if (params.ignoreMode) {
    return params.ignoreMode;
  }

  if (params.ignoreDurationMinutes !== undefined) {
    return "forDuration";
  }

  if (
    params.ignoreCount !== undefined ||
    params.ignoreWindowMinutes !== undefined
  ) {
    return "untilOccurrenceCount";
  }

  if (
    params.ignoreUserCount !== undefined ||
    params.ignoreUserWindowMinutes !== undefined
  ) {
    return "untilUserCount";
  }

  return "untilEscalating";
}

function getIssueStatusDetails(issue: Issue): Record<string, unknown> {
  const statusDetails = issue.statusDetails;

  if (
    statusDetails &&
    typeof statusDetails === "object" &&
    !Array.isArray(statusDetails)
  ) {
    return statusDetails as Record<string, unknown>;
  }

  return {};
}

function getStatusDetailNumber(
  statusDetails: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = statusDetails[key];

  if (typeof value === "number") {
    return value;
  }

  return undefined;
}

function getStatusDetailString(
  statusDetails: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = statusDetails[key];

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return undefined;
}

/** SHA of the commit an issue is resolved in, from the serialized commit. */
function getResolvedCommitId(
  statusDetails: Record<string, unknown>,
  key: "inCommit" | "commit" = "inCommit",
): string | undefined {
  const commit = statusDetails[key];
  if (commit && typeof commit === "object" && !Array.isArray(commit)) {
    const id = (commit as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }

  return undefined;
}

function formatIgnoreUntil(ignoreUntil: string): string {
  const date = new Date(ignoreUntil);
  if (Number.isNaN(date.getTime())) {
    return ignoreUntil;
  }

  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function getIssueStatusDisplay(issue: Issue): IssueStatusDisplay {
  const statusDetails = getIssueStatusDetails(issue);

  if (issue.status === "resolved") {
    if (statusDetails.inNextRelease === true) {
      return "resolvedInNextRelease";
    }
    if (getStatusDetailString(statusDetails, "inRelease")) {
      return "resolvedInRelease";
    }
    if (getResolvedCommitId(statusDetails)) {
      return "resolvedInCommit";
    }
  }

  return issue.status;
}

type ResolutionParams = {
  status?: string;
  inRelease?: string;
  inCommit?: string;
  inCommitRepository?: string;
};

function buildResolution(
  params: ResolutionParams,
): IssueResolutionDetails | undefined {
  if (
    params.inCommitRepository !== undefined &&
    params.inCommit === undefined
  ) {
    throw new UserInputError("`inCommitRepository` requires `inCommit`");
  }

  if (params.inRelease === undefined && params.inCommit === undefined) {
    return undefined;
  }

  if (params.status !== "resolved") {
    throw new UserInputError(
      "`inRelease` and `inCommit` can only be used when `status` is `resolved`",
    );
  }

  if (params.inRelease !== undefined && params.inCommit !== undefined) {
    throw new UserInputError("Choose only one of `inRelease` or `inCommit`");
  }

  if (params.inRelease !== undefined) {
    return { inRelease: params.inRelease };
  }

  if (params.inCommitRepository === undefined) {
    throw new UserInputError("`inCommit` requires `inCommitRepository`");
  }

  return {
    inCommit: {
      commit: params.inCommit!,
      repository: params.inCommitRepository,
    },
  };
}

function isResolutionAlreadySet(
  issue: Issue,
  resolution: IssueResolutionDetails,
): boolean {
  if (issue.status !== "resolved") {
    return false;
  }

  const statusDetails = getIssueStatusDetails(issue);

  if ("inRelease" in resolution) {
    return (
      getStatusDetailString(statusDetails, "inRelease") === resolution.inRelease
    );
  }

  return (
    getResolvedCommitId(statusDetails)?.toLowerCase() ===
    resolution.inCommit.commit.toLowerCase()
  );
}

/**
 * Sentry reports a commit resolution as `inRelease` once a release contains
 * the commit, so the issue details no longer name the commit. The newest
 * resolve activity still does.
 */
async function isLatestResolutionCommit(
  apiService: {
    getIssueActivity: (params: {
      organizationSlug: string;
      issueId: string;
    }) => Promise<IssueActivityList>;
  },
  organizationSlug: string,
  issueId: string,
  commit: string,
): Promise<boolean> {
  const activity = await apiService.getIssueActivity({
    organizationSlug,
    issueId,
  });
  const latestResolution = activity.find((item) =>
    item.type?.startsWith("set_resolved"),
  );

  return (
    latestResolution?.type === "set_resolved_in_commit" &&
    getResolvedCommitId(
      latestResolution.data ?? {},
      "commit",
    )?.toLowerCase() === commit.toLowerCase()
  );
}

function isStatusAlreadySet(
  issue: Issue,
  status: string | undefined,
  resolution: IssueResolutionDetails | undefined,
): boolean {
  if (status === undefined || status === "ignored") {
    return false;
  }

  if (resolution) {
    return isResolutionAlreadySet(issue, resolution);
  }

  const currentStatus = getIssueStatusDisplay(issue);

  // A plain resolve is satisfied by any resolution except next release,
  // which stays pending until a new release exists.
  if (status === "resolved") {
    return (
      currentStatus === "resolved" ||
      currentStatus === "resolvedInRelease" ||
      currentStatus === "resolvedInCommit"
    );
  }

  return currentStatus === status;
}

function getResolvedEffect(
  issue: Issue,
  statusDisplay: IssueStatusDisplay,
): string | null {
  const statusDetails = getIssueStatusDetails(issue);

  switch (statusDisplay) {
    case "resolved":
      return "The issue is now marked as resolved and will no longer generate alerts";
    case "resolvedInNextRelease":
      return "The issue is now marked as resolved in the upcoming release";
    case "resolvedInRelease":
      return `The issue is now marked as resolved in release ${getStatusDetailString(statusDetails, "inRelease")}. Events from newer releases will reopen it as a regression`;
    case "resolvedInCommit":
      return `The issue is now marked as resolved in commit ${getResolvedCommitId(statusDetails)}. It will be resolved in the first release that contains this commit`;
    default:
      return null;
  }
}

function getIgnoreStateFromUpdate(
  ignoreUpdate?: IgnoreUpdate,
): IgnoreState | null {
  if (!ignoreUpdate) {
    return null;
  }

  switch (ignoreUpdate.substatus) {
    case "archived_until_escalating":
      return {
        family: "untilEscalating",
        behavior: ignoreUpdate.behavior,
        message: ignoreUpdate.message,
      };
    case "archived_forever":
      return {
        family: "forever",
        behavior: ignoreUpdate.behavior,
        message: ignoreUpdate.message,
      };
    case "archived_until_condition_met":
      return {
        family: "condition",
        behavior: ignoreUpdate.behavior,
        message: ignoreUpdate.message,
      };
  }
}

function getIgnoreState(
  issue: Issue,
  fallbackIgnoreUpdate?: IgnoreUpdate,
): IgnoreState | null {
  if (issue.status !== "ignored") {
    return null;
  }

  const statusDetails = getIssueStatusDetails(issue);
  const ignoreUntil = getStatusDetailString(statusDetails, "ignoreUntil");
  const ignoreDuration = getStatusDetailNumber(statusDetails, "ignoreDuration");
  const ignoreCount = getStatusDetailNumber(statusDetails, "ignoreCount");
  const ignoreWindow = getStatusDetailNumber(statusDetails, "ignoreWindow");
  const ignoreUserCount = getStatusDetailNumber(
    statusDetails,
    "ignoreUserCount",
  );
  const ignoreUserWindow = getStatusDetailNumber(
    statusDetails,
    "ignoreUserWindow",
  );

  if (
    issue.substatus === "archived_until_escalating" ||
    statusDetails.ignoreUntilEscalating === true
  ) {
    return {
      family: "untilEscalating",
      behavior: "Until escalating",
      message: "The issue is now ignored until it escalates",
    };
  }

  if (issue.substatus === "archived_forever") {
    return {
      family: "forever",
      behavior: "Forever",
      message: "The issue is now ignored indefinitely",
    };
  }

  if (ignoreUntil) {
    const formattedIgnoreUntil = formatIgnoreUntil(ignoreUntil);
    return {
      family: "condition",
      behavior: `Until ${formattedIgnoreUntil}`,
      message: `The issue is now ignored until ${formattedIgnoreUntil}`,
    };
  }

  if (ignoreDuration !== undefined) {
    return {
      family: "condition",
      behavior: `For ${pluralize(ignoreDuration, "minute")}`,
      message: `The issue is now ignored for ${pluralize(ignoreDuration, "minute")}`,
    };
  }

  if (ignoreCount !== undefined && ignoreWindow !== undefined) {
    return {
      family: "condition",
      behavior: `Until it occurs ${pluralize(ignoreCount, "time")} in ${pluralize(ignoreWindow, "minute")}`,
      message: `The issue is now ignored until it occurs ${pluralize(ignoreCount, "time")} in ${pluralize(ignoreWindow, "minute")}`,
    };
  }

  if (ignoreCount !== undefined) {
    return {
      family: "condition",
      behavior: `Until it occurs ${pluralize(ignoreCount, "more time")}`,
      message: `The issue is now ignored until it occurs ${pluralize(ignoreCount, "more time")}`,
    };
  }

  if (ignoreUserCount !== undefined && ignoreUserWindow !== undefined) {
    return {
      family: "condition",
      behavior: `Until it affects ${pluralize(ignoreUserCount, "user")} in ${pluralize(ignoreUserWindow, "minute")}`,
      message: `The issue is now ignored until it affects ${pluralize(ignoreUserCount, "user")} in ${pluralize(ignoreUserWindow, "minute")}`,
    };
  }

  if (ignoreUserCount !== undefined) {
    return {
      family: "condition",
      behavior: `Until it affects ${pluralize(ignoreUserCount, "more user")}`,
      message: `The issue is now ignored until it affects ${pluralize(ignoreUserCount, "more user")}`,
    };
  }

  if (issue.substatus === "archived_until_condition_met") {
    return (
      getIgnoreStateFromUpdate(fallbackIgnoreUpdate) ?? {
        family: "condition",
        behavior: "Until the ignore condition is met",
        message:
          "The issue is now ignored until the configured condition is met",
      }
    );
  }

  return {
    family: "forever",
    behavior: "Forever",
    message: "The issue is now ignored indefinitely",
  };
}

const valueChangeSchema = z.object({ from: z.string(), to: z.string() });

export const updateIssueOutputSchema = z.object({
  organizationSlug: z.string(),
  issueId: z.string(),
  title: z.string(),
  issueUrl: z.string(),
  updated: z
    .boolean()
    .describe(
      "Whether issue state changed. A posted reason comment is reported in reasonComment, not here.",
    ),
  changes: z.object({
    status: valueChangeSchema.nullable(),
    ignoreBehavior: z
      .object({ from: z.string().nullable(), to: z.string() })
      .nullable(),
    assignedTo: valueChangeSchema.nullable(),
    priority: valueChangeSchema.nullable(),
  }),
  current: z.object({
    status: z.string(),
    ignoreBehavior: z.string().nullable(),
    assignedTo: z.string(),
    priority: z.string().nullable(),
  }),
  effect: z
    .string()
    .nullable()
    .describe("What the new status means for the issue, when it changed."),
  reasonComment: z
    .object({
      status: z.enum(["posted", "already_present", "not_posted"]),
      text: z.string(),
      error: z.string().nullable(),
    })
    .nullable()
    .describe("Null when no reason was given."),
});

type UpdateIssueOutput = z.infer<typeof updateIssueOutputSchema>;

function getCurrentState(
  issue: Issue,
  ignoreState: IgnoreState | null,
): UpdateIssueOutput["current"] {
  return {
    status: getIssueStatusDisplay(issue),
    ignoreBehavior: ignoreState?.behavior ?? null,
    assignedTo: formatAssignedTo(issue.assignedTo ?? null),
    priority: issue.priority ?? null,
  };
}

function isAssigneeAlreadySet(
  issue: Issue,
  requestedAssignee: string | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  if (requestedAssignee === undefined) {
    return false;
  }

  if (requestedAssignee === null) {
    return !issue.assignedTo;
  }

  if (!issue.assignedTo) {
    return false;
  }

  if (typeof issue.assignedTo === "string") {
    return issue.assignedTo === requestedAssignee;
  }

  if (requestedAssignee === "me") {
    return (
      issue.assignedTo.type === "user" &&
      currentUserId !== undefined &&
      String(issue.assignedTo.id) === currentUserId
    );
  }

  if (requestedAssignee.startsWith("user:")) {
    return (
      issue.assignedTo.type === "user" &&
      String(issue.assignedTo.id) === requestedAssignee.slice("user:".length)
    );
  }

  if (requestedAssignee.startsWith("team:")) {
    const requestedTeam = requestedAssignee.slice("team:".length);
    return (
      issue.assignedTo.type === "team" &&
      (String(issue.assignedTo.id) === requestedTeam ||
        issue.assignedTo.name === requestedTeam)
    );
  }

  return false;
}

function getIgnoreFamily(
  ignoreUpdate?: IgnoreUpdate,
): IgnoreFamily | undefined {
  switch (ignoreUpdate?.substatus) {
    case "archived_until_escalating":
      return "untilEscalating";
    case "archived_forever":
      return "forever";
    case "archived_until_condition_met":
      return "condition";
    default:
      return undefined;
  }
}

function isIgnoreBehaviorAlreadySet(
  currentIgnoreState: IgnoreState | null,
  ignoreUpdate?: IgnoreUpdate,
): boolean {
  const requestedIgnoreState = getIgnoreStateFromUpdate(ignoreUpdate);

  return (
    currentIgnoreState !== null &&
    requestedIgnoreState !== null &&
    currentIgnoreState.family === requestedIgnoreState.family &&
    currentIgnoreState.behavior === requestedIgnoreState.behavior
  );
}

function buildIgnoreUpdate(
  params: IgnoreParams,
  options: {
    applyDefaultIgnoredMode: boolean;
  },
): IgnoreUpdate | undefined {
  const hasIgnoreOptions = hasExplicitIgnoreChange(params);

  if (!hasIgnoreOptions) {
    if (params.status === "ignored" && options.applyDefaultIgnoredMode) {
      return {
        substatus: "archived_until_escalating",
        behavior: "Until escalating",
        message: "The issue is now ignored until it escalates",
      };
    }

    return undefined;
  }

  if (params.status !== "ignored") {
    throw new UserInputError(
      "Ignore options can only be used when `status` is `ignored`",
    );
  }

  if (
    params.ignoreWindowMinutes !== undefined &&
    params.ignoreCount === undefined
  ) {
    throw new UserInputError("`ignoreWindowMinutes` requires `ignoreCount`");
  }

  if (
    params.ignoreUserWindowMinutes !== undefined &&
    params.ignoreUserCount === undefined
  ) {
    throw new UserInputError(
      "`ignoreUserWindowMinutes` requires `ignoreUserCount`",
    );
  }

  const usesDuration = params.ignoreDurationMinutes !== undefined;
  const usesOccurrence =
    params.ignoreCount !== undefined ||
    params.ignoreWindowMinutes !== undefined;
  const usesUserCount =
    params.ignoreUserCount !== undefined ||
    params.ignoreUserWindowMinutes !== undefined;

  const configuredIgnoreFamilies = [
    usesDuration,
    usesOccurrence,
    usesUserCount,
  ].filter(Boolean).length;

  if (configuredIgnoreFamilies > 1) {
    throw new UserInputError(
      "Choose only one ignore condition: duration, occurrence count, or user count",
    );
  }

  const ignoreMode = inferIgnoreMode(params);

  switch (ignoreMode) {
    case "untilEscalating":
      if (configuredIgnoreFamilies > 0) {
        throw new UserInputError(
          "`ignoreMode='untilEscalating'` cannot be combined with ignore duration, occurrence, or user-count conditions",
        );
      }
      return {
        substatus: "archived_until_escalating",
        behavior: "Until escalating",
        message: "The issue is now ignored until it escalates",
      };
    case "forever":
      if (configuredIgnoreFamilies > 0) {
        throw new UserInputError(
          "`ignoreMode='forever'` cannot be combined with ignore duration, occurrence, or user-count conditions",
        );
      }
      return {
        substatus: "archived_forever",
        behavior: "Forever",
        message: "The issue is now ignored indefinitely",
      };
    case "forDuration":
      if (params.ignoreDurationMinutes === undefined) {
        throw new UserInputError(
          "`ignoreMode='forDuration'` requires `ignoreDurationMinutes`",
        );
      }
      if (usesOccurrence || usesUserCount) {
        throw new UserInputError(
          "`ignoreMode='forDuration'` cannot be combined with ignore occurrence or user-count conditions",
        );
      }
      return {
        substatus: "archived_until_condition_met",
        ignoreDuration: params.ignoreDurationMinutes,
        behavior: `For ${pluralize(params.ignoreDurationMinutes, "minute")}`,
        message: `The issue is now ignored for ${pluralize(params.ignoreDurationMinutes, "minute")}`,
      };
    case "untilOccurrenceCount":
      if (params.ignoreCount === undefined) {
        throw new UserInputError(
          "`ignoreMode='untilOccurrenceCount'` requires `ignoreCount`",
        );
      }
      if (usesDuration || usesUserCount) {
        throw new UserInputError(
          "`ignoreMode='untilOccurrenceCount'` cannot be combined with ignore duration or user-count conditions",
        );
      }
      return {
        substatus: "archived_until_condition_met",
        ignoreCount: params.ignoreCount,
        ignoreWindow: params.ignoreWindowMinutes,
        behavior:
          params.ignoreWindowMinutes === undefined
            ? `Until it occurs ${pluralize(params.ignoreCount, "more time")}`
            : `Until it occurs ${pluralize(params.ignoreCount, "time")} in ${pluralize(params.ignoreWindowMinutes, "minute")}`,
        message:
          params.ignoreWindowMinutes === undefined
            ? `The issue is now ignored until it occurs ${pluralize(params.ignoreCount, "more time")}`
            : `The issue is now ignored until it occurs ${pluralize(params.ignoreCount, "time")} in ${pluralize(params.ignoreWindowMinutes, "minute")}`,
      };
    case "untilUserCount":
      if (params.ignoreUserCount === undefined) {
        throw new UserInputError(
          "`ignoreMode='untilUserCount'` requires `ignoreUserCount`",
        );
      }
      if (usesDuration || usesOccurrence) {
        throw new UserInputError(
          "`ignoreMode='untilUserCount'` cannot be combined with ignore duration or occurrence conditions",
        );
      }
      return {
        substatus: "archived_until_condition_met",
        ignoreUserCount: params.ignoreUserCount,
        ignoreUserWindow: params.ignoreUserWindowMinutes,
        behavior:
          params.ignoreUserWindowMinutes === undefined
            ? `Until it affects ${pluralize(params.ignoreUserCount, "more user")}`
            : `Until it affects ${pluralize(params.ignoreUserCount, "user")} in ${pluralize(params.ignoreUserWindowMinutes, "minute")}`,
        message:
          params.ignoreUserWindowMinutes === undefined
            ? `The issue is now ignored until it affects ${pluralize(params.ignoreUserCount, "more user")}`
            : `The issue is now ignored until it affects ${pluralize(params.ignoreUserCount, "user")} in ${pluralize(params.ignoreUserWindowMinutes, "minute")}`,
      };
  }

  throw new UserInputError("Unsupported ignore mode");
}

type ReasonCommentResult =
  | { posted: true; duplicate?: boolean }
  | { posted: false; skipped: true }
  | { posted: false; error: string };

/**
 * Sentry rejects a note whose text the same user already posted on the issue.
 * That happens when a client retries `update_issue` with the same `reason`;
 * the comment already exists, so the desired outcome is already achieved.
 */
function isDuplicateCommentError(error: unknown): boolean {
  return (
    error instanceof ApiValidationError &&
    error.status === 400 &&
    error.message.toLowerCase().includes("already posted that comment")
  );
}

async function tryPostReasonComment(
  apiService: {
    createIssueComment: (params: {
      organizationSlug: string;
      issueId: string;
      text: string;
    }) => Promise<unknown>;
  },
  organizationSlug: string,
  issueId: string,
  reason: string | undefined,
): Promise<ReasonCommentResult> {
  if (!reason) {
    return { posted: false, skipped: true };
  }
  try {
    await apiService.createIssueComment({
      organizationSlug,
      issueId,
      text: reason,
    });
    return { posted: true };
  } catch (error) {
    if (isDuplicateCommentError(error)) {
      return { posted: true, duplicate: true };
    }
    if (!(error instanceof ApiClientError)) {
      logIssue(error);
    }
    return {
      posted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function getReasonComment(
  reason: string | undefined,
  result: ReasonCommentResult,
): UpdateIssueOutput["reasonComment"] {
  if (!reason || "skipped" in result) {
    return null;
  }
  if (result.posted) {
    return {
      status: result.duplicate ? "already_present" : "posted",
      text: reason,
      error: null,
    };
  }
  return {
    status: "not_posted",
    text: reason,
    error: "error" in result ? result.error : null,
  };
}

/**
 * Identifies an assignee by actor so two users with the same display name
 * still count as different assignees.
 */
function getAssigneeKey(assignedTo: AssignedTo): string {
  if (assignedTo && typeof assignedTo === "object") {
    return `${assignedTo.type}:${assignedTo.id}`;
  }
  return `name:${formatAssignedTo(assignedTo)}`;
}

export default defineTool({
  name: "update_issue",
  title: "Update Issue",
  skills: ["triage"], // Only available in triage skill
  requiredScopes: ["event:write"],
  description:
    "Update a Sentry issue: resolve, ignore (archive), or reopen it, assign it to a user or team, or change its priority.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    issueUrl: ParamIssueUrl.optional(),
    status: ParamIssueStatus.optional(),
    assignedTo: ParamAssignedTo.optional(),
    priority: ParamIssuePriority.optional(),
    ignoreMode: ParamIssueIgnoreMode.optional(),
    ignoreDurationMinutes: ParamIgnoreDurationMinutes.optional(),
    ignoreCount: ParamIgnoreCount.optional(),
    ignoreWindowMinutes: ParamIgnoreWindowMinutes.optional(),
    ignoreUserCount: ParamIgnoreUserCount.optional(),
    ignoreUserWindowMinutes: ParamIgnoreUserWindowMinutes.optional(),
    inRelease: ParamInRelease.optional(),
    inCommit: ParamInCommit.optional(),
    inCommitRepository: ParamInCommitRepository.optional(),
    reason: ParamReason.optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  outputSchema: updateIssueOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });

    // Validate that we have the minimum required parameters
    if (!params.issueUrl && !params.issueId) {
      throw new UserInputError(
        "Either `issueId` or `issueUrl` must be provided",
      );
    }

    if (!params.issueUrl && !params.organizationSlug) {
      throw new UserInputError(
        "`organizationSlug` is required when providing `issueId`",
      );
    }

    // Validate that at least one update parameter is provided
    if (
      params.status === undefined &&
      params.assignedTo === undefined &&
      params.priority === undefined
    ) {
      throw new UserInputError(
        "At least one of `status`, `assignedTo`, or `priority` must be provided to update the issue",
      );
    }

    const resolution = buildResolution(params);

    const { organizationSlug: orgSlug, issueId: parsedIssueId } =
      parseIssueParams({
        organizationSlug: params.organizationSlug,
        issueId: params.issueId,
        issueUrl: params.issueUrl,
      });

    setTargetTagsAndAttributes({ organizationSlug: orgSlug });

    // Get current issue details first
    const currentIssue = await apiService.getIssue({
      organizationSlug: orgSlug,
      issueId: parsedIssueId,
    });
    assertIssueWithinProjectConstraint({
      issue: currentIssue,
      projectSlug: context.constraints.projectSlug,
    });

    const currentIgnoreState = getIgnoreState(currentIssue);
    const assignmentAlreadySet = isAssigneeAlreadySet(
      currentIssue,
      params.assignedTo,
      context.userId,
    );
    const ignoreUpdate = buildIgnoreUpdate(params, {
      applyDefaultIgnoredMode:
        params.status === "ignored" && currentIssue.status !== "ignored",
    });
    const requestedIgnoreFamily = getIgnoreFamily(ignoreUpdate);
    const ignoreBehaviorAlreadySet = isIgnoreBehaviorAlreadySet(
      currentIgnoreState,
      ignoreUpdate,
    );
    let statusAlreadySet = isStatusAlreadySet(
      currentIssue,
      params.status,
      resolution,
    );
    if (
      !statusAlreadySet &&
      resolution &&
      "inCommit" in resolution &&
      getIssueStatusDisplay(currentIssue) === "resolvedInRelease"
    ) {
      statusAlreadySet = await isLatestResolutionCommit(
        apiService,
        orgSlug,
        parsedIssueId,
        resolution.inCommit.commit,
      );
    }

    // Sentry leaves an already resolved issue as it is, so a different release
    // or commit resolution would silently do nothing.
    if (resolution && !statusAlreadySet && currentIssue.status === "resolved") {
      throw new UserInputError(
        `The issue is already resolved (\`${getIssueStatusDisplay(currentIssue)}\`). To resolve it in a different release or commit, first set \`status\` to \`unresolved\`, then resolve it again.`,
      );
    }

    let updateStatus = statusAlreadySet ? undefined : params.status;
    const updateAssignedTo = assignmentAlreadySet
      ? undefined
      : params.assignedTo;
    const updatePriority =
      params.priority === currentIssue.priority ? undefined : params.priority;
    let updateIgnore = ignoreUpdate;

    if (currentIssue.status === "ignored" && params.status === "ignored") {
      if (!hasExplicitIgnoreChange(params)) {
        updateStatus = undefined;
        updateIgnore = undefined;
      } else if (ignoreBehaviorAlreadySet) {
        updateStatus = undefined;
        updateIgnore = undefined;
      } else if (
        currentIgnoreState &&
        requestedIgnoreFamily &&
        currentIgnoreState.family !== requestedIgnoreFamily
      ) {
        throw new UserInputError(
          "Changing ignore behavior on an already ignored issue between `untilEscalating`, `forever`, and condition-based modes is not supported. First set `status` to `unresolved`, then ignore it again with the new rule.",
        );
      }
    }

    const requestedIssueUrl = apiService.getIssueUrl(
      orgSlug,
      currentIssue.shortId,
    );

    if (
      updateStatus === undefined &&
      updateAssignedTo === undefined &&
      updatePriority === undefined &&
      updateIgnore === undefined
    ) {
      const commentResult = await tryPostReasonComment(
        apiService,
        orgSlug,
        parsedIssueId,
        params.reason,
      );

      return structuredResult({
        organizationSlug: orgSlug,
        issueId: currentIssue.shortId,
        title: currentIssue.title,
        issueUrl: requestedIssueUrl,
        updated: false,
        changes: {
          status: null,
          ignoreBehavior: null,
          assignedTo: null,
          priority: null,
        },
        current: getCurrentState(currentIssue, currentIgnoreState),
        effect: null,
        reasonComment: getReasonComment(params.reason, commentResult),
      } satisfies UpdateIssueOutput);
    }

    // Update the issue
    const updatedIssue = await apiService.updateIssue({
      organizationSlug: orgSlug,
      issueId: parsedIssueId,
      status: updateStatus,
      statusDetails: updateStatus === undefined ? undefined : resolution,
      assignedTo: updateAssignedTo,
      priority: updatePriority,
      substatus: updateIgnore?.substatus,
      ignoreDuration: updateIgnore?.ignoreDuration,
      ignoreCount: updateIgnore?.ignoreCount,
      ignoreWindow: updateIgnore?.ignoreWindow,
      ignoreUserCount: updateIgnore?.ignoreUserCount,
      ignoreUserWindow: updateIgnore?.ignoreUserWindow,
    });

    const commentResult = await tryPostReasonComment(
      apiService,
      orgSlug,
      parsedIssueId,
      params.reason,
    );

    const updatedIgnoreState = getIgnoreState(updatedIssue, ignoreUpdate);
    const currentStatusDisplay = getIssueStatusDisplay(currentIssue);
    const updatedStatusDisplay = getIssueStatusDisplay(updatedIssue);
    const statusChanged = currentStatusDisplay !== updatedStatusDisplay;
    const assignmentChanged =
      getAssigneeKey(currentIssue.assignedTo ?? null) !==
      getAssigneeKey(updatedIssue.assignedTo ?? null);
    const ignoreBehaviorChanged =
      currentIgnoreState?.behavior !== updatedIgnoreState?.behavior;

    const showIgnoreChange =
      updatedIgnoreState !== null &&
      (statusChanged || ignoreBehaviorChanged) &&
      (ignoreBehaviorChanged || params.status === "ignored");

    let effect = statusChanged
      ? getResolvedEffect(updatedIssue, updatedStatusDisplay)
      : null;
    if (
      effect === null &&
      updatedIgnoreState &&
      params.status === "ignored" &&
      (statusChanged || ignoreBehaviorChanged)
    ) {
      effect = updatedIgnoreState.message;
    }

    const changes: UpdateIssueOutput["changes"] = {
      status: statusChanged
        ? { from: currentStatusDisplay, to: updatedStatusDisplay }
        : null,
      ignoreBehavior: showIgnoreChange
        ? {
            from:
              currentIgnoreState && ignoreBehaviorChanged
                ? currentIgnoreState.behavior
                : null,
            to: updatedIgnoreState.behavior,
          }
        : null,
      assignedTo:
        updateAssignedTo !== undefined && assignmentChanged
          ? {
              from: formatAssignedTo(currentIssue.assignedTo ?? null),
              to:
                params.assignedTo === "me"
                  ? "You"
                  : formatAssignedTo(updatedIssue.assignedTo ?? null),
            }
          : null,
      priority:
        updatePriority !== undefined &&
        currentIssue.priority !== updatedIssue.priority
          ? {
              from: currentIssue.priority ?? "none",
              to: updatedIssue.priority ?? "none",
            }
          : null,
    };

    return structuredResult({
      organizationSlug: orgSlug,
      issueId: updatedIssue.shortId,
      title: updatedIssue.title,
      issueUrl: apiService.getIssueUrl(orgSlug, updatedIssue.shortId),
      updated: Object.values(changes).some(Boolean),
      changes,
      current: getCurrentState(updatedIssue, updatedIgnoreState),
      effect,
      reasonComment: getReasonComment(params.reason, commentResult),
    } satisfies UpdateIssueOutput);
  },
});
