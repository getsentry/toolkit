/**
 * sentry onboarding progress
 *
 * Report agent onboarding progress to Sentry.
 */

import type { SentryContext } from "../../context.js";
import { updateOnboardingStatus } from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import { parseProjectList, parseText } from "../../lib/completion-target.js";
import { ApiError, ContextError, ValidationError } from "../../lib/errors.js";
import { getEnv } from "../../lib/env.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { type OrgTarget, orgTarget } from "../../lib/target-positional.js";
import {
  ONBOARDING_STAGES,
  ONBOARDING_STAGE_STATUSES,
  ONBOARDING_RUN_STATUSES,
  type OnboardingProgress,
  type OnboardingStage,
  type OnboardingStageStatus,
  type OnboardingRunStatus,
  type OnboardingStageExtra,
} from "../../types/onboarding.js";
import { OnboardingProgressSchema } from "../../generated/output-schemas/onboarding.js";

const STATUS_SCHEMA_VERSION = 1;
const CONNECTION_METHOD = "cli" as const;
const RUN_CODE_PATTERN = /^[A-Za-z0-9]{10}$/;
const CLOSED_RUN_STATUSES = new Set([404, 409, 410]);
const CLOSED_RUN_MESSAGE =
  "This onboarding run no longer accepts updates. Stop sending onboarding updates.";
const CREATE_PROJECT_STAGE: OnboardingStage = "create_project";
const RECEIVE_VERIFICATION_ERROR_STAGE: OnboardingStage =
  "receive_verification_error";
const CONNECT_AGENT_STAGE: OnboardingStage = "connect_agent";

type ProgressFlags = {
  readonly stage: OnboardingStage;
  readonly status: OnboardingStageStatus;
  readonly "run-status"?: OnboardingRunStatus;
  readonly "run-code"?: string;
  readonly note?: string;
  readonly project?: string;
  readonly issue?: string;
  readonly json: boolean;
  readonly fields?: string[];
};

/**
 * Resolve the onboarding run code from the flag value or the environment.
 * Throws if neither is set or the code is malformed.
 */
export function resolveRunCode(flag: string | undefined): string {
  const raw = flag ?? getEnv().SENTRY_ONBOARDING_RUN_CODE;
  const code = raw?.trim();
  if (!code) {
    throw new ContextError(
      "Onboarding run code",
      "sentry onboarding progress --run-code <code> --stage <stage> --status <status>",
      ["Set SENTRY_ONBOARDING_RUN_CODE"],
    );
  }
  if (!RUN_CODE_PATTERN.test(code)) {
    throw new ValidationError(
      "Invalid onboarding run code: expected 10 letters or digits.",
      "run-code",
    );
  }
  return code;
}

/**
 * Build the stage-specific extra payload, or throw if a metadata flag is
 * used on the wrong stage.
 */
export function buildStageExtra(
  flags: ProgressFlags,
): OnboardingStageExtra | undefined {
  if (flags.project !== undefined && flags.stage !== CREATE_PROJECT_STAGE) {
    throw new ValidationError(
      `--project is only accepted for the ${CREATE_PROJECT_STAGE} stage.`,
      "project",
    );
  }
  if (
    flags.issue !== undefined &&
    flags.stage !== RECEIVE_VERIFICATION_ERROR_STAGE
  ) {
    throw new ValidationError(
      `--issue is only accepted for the ${RECEIVE_VERIFICATION_ERROR_STAGE} stage.`,
      "issue",
    );
  }

  if (flags.stage === CONNECT_AGENT_STAGE) {
    return { method: CONNECTION_METHOD };
  }
  if (flags.project !== undefined) {
    return { projectSlugs: flags.project.split(",").map((p) => p.trim()) };
  }
  if (flags.issue !== undefined) {
    return { issueIds: flags.issue.split(",").map((i) => i.trim()) };
  }
  return undefined;
}

/**
 * Map 404, 409, and 410 API errors to the standard stop message. Any other
 * error is returned unchanged.
 */
export function toClosedRunError(error: unknown): unknown {
  if (error instanceof ApiError && CLOSED_RUN_STATUSES.has(error.status)) {
    return new ApiError(
      CLOSED_RUN_MESSAGE,
      error.status,
      error.detail,
      error.endpoint,
    );
  }
  return error;
}

export function formatProgress({
  continueUpdates,
}: OnboardingProgress): string {
  return `Onboarding progress updated. Continue updates: ${continueUpdates ? "yes" : "no"}.`;
}

export const progressCommand = buildCommand({
  docs: {
    brief: "Report agent onboarding progress",
    fullDescription:
      "Send a progress update for a stage of Sentry's agentic onboarding flow.\n\n" +
      "The run code links this update to the user's onboarding page. Pass it with\n" +
      "--run-code or set SENTRY_ONBOARDING_RUN_CODE. Never share or print the code.\n\n" +
      "If the reply says continueUpdates is false, or the command exits with the\n" +
      "stop message, send no further updates and continue setup.",
    examples: [
      {
        description: "Report that the agent has connected",
        command:
          "sentry onboarding progress my-org --run-code abcd12efg0 --stage connect_agent --status completed",
      },
      {
        description: "Report a project created with two slugs",
        command:
          "sentry onboarding progress my-org --run-code abcd12efg0 --stage create_project --status completed --project web,api",
      },
      {
        description: "Report a failed stage with a note",
        command:
          'sentry onboarding progress my-org --run-code abcd12efg0 --stage instrument_app --status failed --note "SDK initialization failed."',
      },
      {
        description: "Report the final stage and mark the run complete",
        command:
          "sentry onboarding progress my-org --run-code abcd12efg0 --stage check_stack_trace_quality --status completed --run-status completed",
      },
      {
        description: "Output as JSON",
        command:
          "sentry onboarding progress my-org --run-code abcd12efg0 --stage analyze_project --status active --json",
      },
    ],
  },
  output: { human: formatProgress, schema: OnboardingProgressSchema },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "org",
          brief: "Organization slug (optional if auto-detected)",
          parse: orgTarget,
          optional: true,
        },
      ],
    },
    flags: {
      stage: {
        kind: "enum",
        values: ONBOARDING_STAGES,
        brief: "Onboarding stage to report progress for",
      },
      status: {
        kind: "enum",
        values: ONBOARDING_STAGE_STATUSES,
        brief: "Current status of the stage",
      },
      "run-status": {
        kind: "enum",
        values: ONBOARDING_RUN_STATUSES,
        brief: "Set only when the entire run has completed or failed",
        optional: true,
      },
      "run-code": {
        kind: "parsed",
        parse: parseText,
        brief:
          "10-character onboarding run code (or set SENTRY_ONBOARDING_RUN_CODE)",
        optional: true,
      },
      note: {
        kind: "parsed",
        parse: parseText,
        brief:
          "Short context to display with this update. Required when status is failed",
        optional: true,
      },
      project: {
        kind: "parsed",
        parse: parseProjectList,
        brief: "Comma-separated project slugs (create_project stage only)",
        optional: true,
      },
      issue: {
        kind: "parsed",
        parse: parseText,
        brief:
          "Comma-separated issue IDs (receive_verification_error stage only)",
        optional: true,
      },
    },
  },
  async *func(this: SentryContext, flags: ProgressFlags, target: OrgTarget) {
    const runToken = resolveRunCode(flags["run-code"]);
    const extra = buildStageExtra(flags);
    const { org } = await target.resolved;

    let progress: OnboardingProgress;
    try {
      progress = await updateOnboardingStatus(org, {
        schemaVersion: STATUS_SCHEMA_VERSION,
        runToken,
        stage: flags.stage,
        status: flags.status,
        ...(flags.note && { eventNote: flags.note }),
        ...(flags["run-status"] && { runStatus: flags["run-status"] }),
        ...(extra && { extra }),
      });
    } catch (error) {
      throw toClosedRunError(error);
    }
    yield new CommandOutput(progress);
  },
});
