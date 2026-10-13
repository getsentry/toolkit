/**
 * Seer AI API functions
 *
 * Functions for Seer-powered root cause analysis, autofix state,
 * and solution planning. Uses the agent-based (explorer) endpoint
 * which returns blocks instead of steps.
 */

import {
  type AutofixResponse,
  AutofixResponseSchema,
  type AutofixState,
} from "../../types/seer.js";

import {
  type ExplorerSession,
  ExplorerResponseSchema,
  type UserInputResponse,
} from "../../types/seer-fix.js";

import { buildIssueUrl } from "../sentry-urls.js";
import { resolveOrgRegion } from "../region.js";

import { apiRequestToRegion } from "./infrastructure.js";

/** Query params to activate the agent-based autofix endpoint */
const EXPLORER_MODE_PARAMS = { mode: "explorer" };

/**
 * Normalize agent status values to the uppercase format used throughout the CLI.
 *
 * The agent endpoint returns lowercase statuses (`processing`, `completed`,
 * `error`, `awaiting_user_input`, `canceled`) while the CLI expects uppercase
 * (`PROCESSING`, `COMPLETED`, `ERROR`, `WAITING_FOR_USER_RESPONSE`, `CANCELLED`).
 *
 * Explicit cases are required for any status whose CLI name differs from a naive
 * `toUpperCase()`. In particular `canceled` (US spelling) must map to `CANCELLED`
 * (British, used in TERMINAL_STATUSES) — otherwise `isTerminalStatus("CANCELED")`
 * returns false and polling spins until timeout. `awaiting_user_input` maps to
 * `WAITING_FOR_USER_RESPONSE`.
 */
export function normalizeAgentStatus(
  status: string | null | undefined,
): string {
  if (!status) {
    return "PROCESSING";
  }
  switch (status) {
    case "processing":
      return "PROCESSING";
    case "completed":
      return "COMPLETED";
    case "error":
      return "ERROR";
    case "canceled":
    case "cancelled":
      return "CANCELLED";
    case "awaiting_user_input":
      return "WAITING_FOR_USER_RESPONSE";
    case "need_more_information":
      return "NEED_MORE_INFORMATION";
    default:
      return status.toUpperCase();
  }
}

/**
 * Trigger root cause analysis for an issue using Seer AI.
 * Uses the agent-based endpoint with region-aware routing.
 *
 * @param orgSlug - The organization slug
 * @param issueId - The numeric Sentry issue ID
 * @returns The trigger response with `sentry_run_id` and the legacy `run_id`
 * @throws {ApiError} On API errors (402 = no budget, 403 = not enabled)
 */
export async function triggerRootCauseAnalysis(
  orgSlug: string,
  issueId: string,
): Promise<{ run_id?: number; sentry_run_id: string | null }> {
  const regionUrl = await resolveOrgRegion(orgSlug);

  const { data } = await apiRequestToRegion<{
    run_id?: number;
    sentry_run_id: string | null;
  }>(regionUrl, `/organizations/${orgSlug}/issues/${issueId}/autofix/`, {
    method: "POST",
    params: EXPLORER_MODE_PARAMS,
    body: {
      step: "root_cause",
      referrer: "api.cli",
    },
  });
  return data;
}

/**
 * Get the current autofix state for an issue.
 * Uses the agent-based endpoint with region-aware routing.
 *
 * @param orgSlug - The organization slug
 * @param issueId - The numeric Sentry issue ID
 * @returns The autofix state, or null if no autofix has been run
 */
export async function getAutofixState(
  orgSlug: string,
  issueId: string,
  options: { bypassCache?: boolean; signal?: AbortSignal } = {},
): Promise<AutofixState | null> {
  const regionUrl = await resolveOrgRegion(orgSlug);

  const { data } = await apiRequestToRegion<AutofixResponse>(
    regionUrl,
    `/organizations/${orgSlug}/issues/${issueId}/autofix/`,
    {
      params: EXPLORER_MODE_PARAMS,
      schema: AutofixResponseSchema,
      ...options,
    },
  );

  if (!data.autofix) {
    return null;
  }

  // Normalize agent status to uppercase format used by the CLI
  data.autofix.status = normalizeAgentStatus(data.autofix.status);
  return data.autofix;
}

/**
 * Trigger solution planning for an existing autofix run.
 *
 * Posts to the agent-based autofix endpoint with `step: "solution"` and
 * the existing run ID (from {@link requireAutofixRunId}).
 *
 * @param orgSlug - The organization slug
 * @param issueId - The numeric Sentry issue ID
 * @param runId - The autofix run ID (see {@link requireAutofixRunId})
 * @returns The response from the API
 */
export async function triggerSolutionPlanning(
  orgSlug: string,
  issueId: string,
  runId: string | number,
): Promise<unknown> {
  const regionUrl = await resolveOrgRegion(orgSlug);

  // A UUID sent under run_id (an IntegerField) fails server-side validation.
  const runIdBodyField =
    typeof runId === "string" ? { sentry_run_id: runId } : { run_id: runId };

  const { data } = await apiRequestToRegion(
    regionUrl,
    `/organizations/${orgSlug}/issues/${issueId}/autofix/`,
    {
      method: "POST",
      params: EXPLORER_MODE_PARAMS,
      body: {
        step: "solution",
        ...runIdBodyField,
        referrer: "api.cli",
      },
    },
  );
  return data;
}

/** Start an interactive chat; the autofix kickoff disables interactive tools. */
export async function triggerIssueFix(
  orgSlug: string,
  issueId: string,
  options: { instruction?: string; signal?: AbortSignal } = {},
): Promise<{ run_id?: number; sentry_run_id?: string | null }> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const query = [
    `Investigate Sentry issue ${orgSlug}/${issueId}. Explain the root cause, propose a fix, and generate code changes for review.`,
    "Ask clarifying questions and request approvals as needed. Stop after generating code changes so the user can review them.",
    "Do not create pull requests, commit changes, or push branches.",
    ...(options.instruction === undefined
      ? []
      : [`Additional instructions from the user: ${options.instruction}`]),
  ].join("\n\n");
  const { data } = await apiRequestToRegion<{
    run_id?: number;
    sentry_run_id?: string | null;
  }>(
    regionUrl,
    `/organizations/${encodeURIComponent(orgSlug)}/seer/explorer-chat/`,
    {
      method: "POST",
      retry: false,
      signal: options.signal,
      body: {
        query,
        on_page_context: `Sentry issue: ${orgSlug}/${issueId}\nIssue URL: ${buildIssueUrl(orgSlug, issueId)}`,
      },
    },
  );
  return data;
}

/** Read a specific run, never the issue's mutable current-run pointer. */
export async function getSeerExplorerState(
  orgSlug: string,
  runId: string | number,
  options: { signal?: AbortSignal } = {},
): Promise<ExplorerSession | null> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const { data } = await apiRequestToRegion(
    regionUrl,
    `/organizations/${encodeURIComponent(orgSlug)}/seer/explorer-chat/${encodeURIComponent(String(runId))}/`,
    { schema: ExplorerResponseSchema, bypassCache: true, ...options },
  );
  if (!data.session) {
    return null;
  }
  data.session.status = normalizeAgentStatus(data.session.status);
  return data.session;
}

/** Submit exactly one structured answer. Uncertain POSTs must never be replayed. */
export async function respondToSeerUserInput(
  orgSlug: string,
  runId: string | number,
  response: UserInputResponse,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  await apiRequestToRegion(
    regionUrl,
    `/organizations/${encodeURIComponent(orgSlug)}/seer/explorer-update/${encodeURIComponent(String(runId))}/`,
    {
      method: "POST",
      retry: false,
      signal: options.signal,
      body: { payload: { type: "user_input_response", ...response } },
    },
  );
}
