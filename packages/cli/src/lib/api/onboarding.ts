/**
 * Onboarding progress API functions
 *
 * Functions for reporting agent onboarding progress to Sentry.
 * Uses region-aware routing through resolveOrgRegion + apiRequestToRegion.
 */

import {
  type OnboardingProgress,
  OnboardingProgressSchema,
  type OnboardingStatusUpdate,
} from "../../types/onboarding.js";
import { resolveOrgRegion } from "../region.js";
import { apiRequestToRegion } from "./infrastructure.js";

/**
 * Report agent onboarding progress for an organization.
 *
 * Uses region-aware routing. The run token travels in the request body and
 * is never logged or included in any URL path.
 *
 * @param orgSlug - The organization slug
 * @param update - Stage, status, and optional metadata for this update
 * @returns Whether Sentry wants further updates for this run
 */
export async function updateOnboardingStatus(
  orgSlug: string,
  update: OnboardingStatusUpdate,
): Promise<OnboardingProgress> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const { data } = await apiRequestToRegion(
    regionUrl,
    `/organizations/${orgSlug}/onboarding/agent/status/`,
    {
      method: "POST",
      body: update,
      schema: OnboardingProgressSchema,
    },
  );
  return data;
}
