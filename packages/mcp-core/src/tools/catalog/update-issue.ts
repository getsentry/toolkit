import type { Issue } from "../../api-client/types";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { formatAssignedTo } from "../../internal/tool-helpers/formatting";
import {
  assertIssueWithinProjectConstraint,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import {
  ParamAssignedTo,
  ParamIgnoreCount,
  ParamIgnoreDurationMinutes,
  ParamIgnoreUserCount,
  ParamIgnoreUserWindowMinutes,
  ParamIgnoreWindowMinutes,
  ParamIssueIgnoreMode,
  ParamIssueShortId,
  ParamIssueStatus,
  ParamIssueUrl,
  ParamOrganizationSlug,
  ParamReason,
  ParamRegionUrl,
} from "../../schema";
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

type IssueStatusDisplay =
  | "resolved"
  | "resolvedInNextRelease"
  | "unresolved"
  | "ignored"
  | string;

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

function formatIgnoreUntil(ignoreUntil: string): string {
  const date = new Date(ignoreUntil);
  if (Number.isNaN(date.getTime())) {
    return ignoreUntil;
  }

  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function getIssueStatusDisplay(issue: Issue): IssueStatusDisplay {
  const statusDetails = getIssueStatusDetails(issue);

  if (issue.status === "resolved" && statusDetails.inNextRelease === true) {
    return "resolvedInNextRelease";
  }

  return issue.status;
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

function buildNoChangesOutput(params: {
  issue: Issue;
  organizationSlug: string;
  ignoreState: IgnoreState | null;
  issueUrl: string;
}): string {
  const { issue, organizationSlug, ignoreState, issueUrl } = params;
  let output = `# Issue ${issue.shortId} Already Matches Requested State in **${organizationSlug}**\n\n`;
  output += `**Issue**: ${issue.title}\n`;
  output += `**URL**: ${issueUrl}\n\n`;

  output += "## Changes Made\n\n";
  output += "No changes were needed.\n";

  output += "\n## Current Status\n\n";
  output += `**Status**: ${getIssueStatusDisplay(issue)}\n`;
  if (ignoreState) {
    output += `**Ignore Behavior**: ${ignoreState.behavior}\n`;
  }
  output += `**Assigned To**: ${formatAssignedTo(issue.assignedTo ?? null)}\n`;

  output += "\n## Response Notes\n\n";
  output += "- The issue already matched the requested state.\n";
  output += `- Full issue details: \`get_sentry_resource(resourceType="issue", organizationSlug="${organizationSlug}", resourceId="${issue.shortId}")\`\n`;

  return output;
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
  | { posted: true }
  | { posted: false; skipped: true }
  | { posted: false; error: string };

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
    logIssue(error);
    return {
      posted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatReasonCommentLine(
  reason: string | undefined,
  result: ReasonCommentResult,
): string {
  if (!reason || ("skipped" in result && result.skipped)) {
    return "";
  }
  if (result.posted) {
    return `- **Comment posted**: "${reason}"\n`;
  }
  if ("error" in result) {
    return `- **Comment not posted**: ${result.error}\n`;
  }
  return "";
}

export default defineTool({
  name: "update_issue",
  skills: ["triage"], // Only available in triage skill
  requiredScopes: ["event:write"],
  description: [
    "Update a Sentry issue's status or assignment.",
    "",
    "Use this to resolve, reopen, assign, unassign, or ignore an issue.",
    "",
    "<examples>",
    "```",
    "update_issue(organizationSlug='my-org', issueId='PROJECT-123', status='resolved')",
    "update_issue(organizationSlug='my-org', issueId='PROJECT-123', assignedTo='user:123456')",
    "update_issue(organizationSlug='my-org', issueId='PROJECT-123', assignedTo=null)",
    "update_issue(organizationSlug='my-org', issueId='PROJECT-123', status='ignored')",
    "update_issue(organizationSlug='my-org', issueId='PROJECT-123', status='ignored', ignoreMode='forever')",
    "update_issue(organizationSlug='my-org', issueId='PROJECT-123', status='ignored', ignoreMode='untilOccurrenceCount', ignoreCount=100, ignoreWindowMinutes=60)",
    "update_issue(organizationSlug='my-org', issueId='PROJECT-123', status='ignored', reason='Ignoring because this is expected noise from the staging deploy')",
    "```",
    "</examples>",
    "",
    "<hints>",
    "- Provide `issueUrl` or `organizationSlug` + `issueId`.",
    "- At least one of `status` or `assignedTo` is required.",
    "- Omit `assignedTo` to leave assignment unchanged. Pass `null` to unassign; otherwise use `user:ID` or `team:ID_OR_SLUG`.",
    "- Use `execute_sentry_tool(name='whoami', arguments={})` to find your user ID for self-assignment.",
    "- Status values: `resolved`, `resolvedInNextRelease`, `unresolved`, `ignored`.",
    "- `status='ignored'` defaults to `ignoreMode='untilEscalating'`.",
    "- Ignore modes: `untilEscalating`, `forever`, `forDuration`, `untilOccurrenceCount`, `untilUserCount`.",
    "- Matching ignore inputs are `ignoreDurationMinutes`, `ignoreCount` + optional `ignoreWindowMinutes`, or `ignoreUserCount` + optional `ignoreUserWindowMinutes`.",
    "- To switch an already ignored issue between `untilEscalating`, `forever`, and condition-based ignore modes, first set `status='unresolved'`, then ignore it again with the new rule.",
    "- `reason` is optional. When provided, it will be posted as a comment on the issue's activity feed explaining why the action was taken.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    issueUrl: ParamIssueUrl.optional(),
    status: ParamIssueStatus.optional(),
    assignedTo: ParamAssignedTo.optional(),
    ignoreMode: ParamIssueIgnoreMode.optional(),
    ignoreDurationMinutes: ParamIgnoreDurationMinutes.optional(),
    ignoreCount: ParamIgnoreCount.optional(),
    ignoreWindowMinutes: ParamIgnoreWindowMinutes.optional(),
    ignoreUserCount: ParamIgnoreUserCount.optional(),
    ignoreUserWindowMinutes: ParamIgnoreUserWindowMinutes.optional(),
    reason: ParamReason.optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
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
    if (params.status === undefined && params.assignedTo === undefined) {
      throw new UserInputError(
        "At least one of `status` or `assignedTo` must be provided to update the issue",
      );
    }

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
      issueId: parsedIssueId!,
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
    const statusAlreadySet =
      params.status !== undefined &&
      params.status !== "ignored" &&
      getIssueStatusDisplay(currentIssue) === params.status;

    let updateStatus = statusAlreadySet ? undefined : params.status;
    const updateAssignedTo = assignmentAlreadySet
      ? undefined
      : params.assignedTo;
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
      updateIgnore === undefined
    ) {
      const commentResult = await tryPostReasonComment(
        apiService,
        orgSlug,
        parsedIssueId!,
        params.reason,
      );

      return (
        buildNoChangesOutput({
          issue: currentIssue,
          organizationSlug: orgSlug,
          ignoreState: currentIgnoreState,
          issueUrl: requestedIssueUrl,
        }) + formatReasonCommentLine(params.reason, commentResult)
      );
    }

    // Update the issue
    const updatedIssue = await apiService.updateIssue({
      organizationSlug: orgSlug,
      issueId: parsedIssueId!,
      status: updateStatus,
      assignedTo: updateAssignedTo,
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
      parsedIssueId!,
      params.reason,
    );

    const updatedIgnoreState = getIgnoreState(updatedIssue, ignoreUpdate);
    const currentStatusDisplay = getIssueStatusDisplay(currentIssue);
    const updatedStatusDisplay = getIssueStatusDisplay(updatedIssue);
    const statusChanged = currentStatusDisplay !== updatedStatusDisplay;
    const assignmentChanged =
      formatAssignedTo(currentIssue.assignedTo ?? null) !==
      formatAssignedTo(updatedIssue.assignedTo ?? null);
    const ignoreBehaviorChanged =
      currentIgnoreState?.behavior !== updatedIgnoreState?.behavior;

    let output = `# Issue ${updatedIssue.shortId} Updated in **${orgSlug}**\n\n`;
    output += `**Issue**: ${updatedIssue.title}\n`;
    output += `**URL**: ${apiService.getIssueUrl(orgSlug, updatedIssue.shortId)}\n\n`;

    // Show what changed
    output += "## Changes Made\n\n";

    if (statusChanged) {
      output += `**Status**: ${currentStatusDisplay} → **${updatedStatusDisplay}**\n`;
    }

    if (
      updatedIgnoreState &&
      (statusChanged || ignoreBehaviorChanged) &&
      (ignoreBehaviorChanged || params.status === "ignored")
    ) {
      if (currentIgnoreState && ignoreBehaviorChanged) {
        output += `**Ignore Behavior**: ${currentIgnoreState.behavior} → **${updatedIgnoreState.behavior}**\n`;
      } else {
        output += `**Ignore Behavior**: **${updatedIgnoreState.behavior}**\n`;
      }
    }

    if (updateAssignedTo !== undefined && assignmentChanged) {
      const oldAssignee = formatAssignedTo(currentIssue.assignedTo ?? null);
      const newAssignee =
        params.assignedTo === "me"
          ? "You"
          : formatAssignedTo(updatedIssue.assignedTo ?? null);
      output += `**Assigned To**: ${oldAssignee} → **${newAssignee}**\n`;
    }

    output += "\n## Current Status\n\n";
    output += `**Status**: ${updatedStatusDisplay}\n`;
    if (updatedIgnoreState) {
      output += `**Ignore Behavior**: ${updatedIgnoreState.behavior}\n`;
    }
    const currentAssignee = formatAssignedTo(updatedIssue.assignedTo ?? null);
    output += `**Assigned To**: ${currentAssignee}\n`;

    output += "\n## Response Notes\n\n";
    output += `- The issue has been updated in Sentry.\n`;
    output += `- Full issue details: \`get_sentry_resource(resourceType="issue", organizationSlug="${orgSlug}", resourceId="${updatedIssue.shortId}")\`\n`;

    if (statusChanged && updatedStatusDisplay === "resolved") {
      output += `- The issue is now marked as resolved and will no longer generate alerts\n`;
    } else if (
      statusChanged &&
      updatedStatusDisplay === "resolvedInNextRelease"
    ) {
      output += `- The issue is now marked as resolved in the upcoming release\n`;
    } else if (
      updatedIgnoreState &&
      params.status === "ignored" &&
      (statusChanged || ignoreBehaviorChanged)
    ) {
      output += `- ${updatedIgnoreState.message}\n`;
    }

    output += formatReasonCommentLine(params.reason, commentResult);

    return output;
  },
});
