/**
 * Onboarding progress types and Valibot schemas.
 *
 * Schemas for the onboarding status update request and the response returned
 * by the POST /organizations/:org/onboarding/agent/status/ endpoint.
 */

import {
  boolean,
  type InferOutput,
  object,
  pipe,
  string,
  description,
} from "valibot";

export const ONBOARDING_STAGES = [
  "connect_agent",
  "analyze_project",
  "create_project",
  "instrument_app",
  "plan_test_error",
  "send_verification_error",
  "receive_verification_error",
  "prepare_production",
  "check_stack_trace_quality",
] as const;

export const ONBOARDING_STAGE_STATUSES = [
  "active",
  "waiting",
  "completed",
  "skipped",
  "failed",
] as const;

export const ONBOARDING_RUN_STATUSES = ["completed", "failed"] as const;

export type OnboardingStage = (typeof ONBOARDING_STAGES)[number];
export type OnboardingStageStatus = (typeof ONBOARDING_STAGE_STATUSES)[number];
export type OnboardingRunStatus = (typeof ONBOARDING_RUN_STATUSES)[number];

export type OnboardingStageExtra =
  | { method: "cli" }
  | { projectSlugs: string[] }
  | { issueIds: string[] };

export type OnboardingStatusUpdate = {
  schemaVersion: 1;
  runToken: string;
  stage: OnboardingStage;
  status: OnboardingStageStatus;
  eventNote?: string;
  runStatus?: OnboardingRunStatus;
  extra?: OnboardingStageExtra;
};

/**
 * Response schema for a single onboarding status update.
 *
 * Uses `object` (strict) so only the field the CLI needs survives parsing —
 * the full run state stays server-side. Validated at runtime on each API
 * response.
 */
export const OnboardingProgressSchema = object({
  continueUpdates: pipe(
    boolean(),
    description("False when Sentry wants no further updates for this run."),
  ),
});

export type OnboardingProgress = InferOutput<typeof OnboardingProgressSchema>;
