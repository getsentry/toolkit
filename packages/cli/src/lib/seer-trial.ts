/**
 * Seer Trial Prompt
 *
 * Interactive flow to check for and start a Seer product trial
 * when a Seer command fails due to budget/enablement errors.
 *
 * Called from cli.ts when a SeerError is caught. Checks trial availability
 * via the customer API, prompts the user for confirmation, and starts the
 * trial if accepted. All failures degrade gracefully — the original error
 * is re-thrown by the caller if this function returns false.
 */

import { isatty } from "node:tty";

import { getProductTrials, startProductTrial } from "./api-client.js";
import { SeerError, type SeerErrorReason } from "./errors.js";
import { logger } from "./logger.js";
import { buildBillingUrl } from "./sentry-urls.js";
import { findAvailableTrial } from "./trials.js";

/** Seer error reasons eligible for trial prompt */
const TRIAL_ELIGIBLE_REASONS: ReadonlySet<SeerErrorReason> = new Set([
  "no_budget",
  "not_enabled",
]);

/** User-facing context messages shown before the trial prompt */
const REASON_CONTEXT: Record<string, string> = {
  no_budget: "Your organization has run out of Seer quota.",
  not_enabled: "Seer is not enabled for your organization.",
};

/**
 * Check whether an error is a trial-eligible SeerError.
 *
 * Performs the `instanceof SeerError` check internally so callers
 * can pass any caught error without narrowing first.
 *
 * Only `no_budget` and `not_enabled` are eligible — `ai_disabled` is
 * an explicit admin decision that a trial wouldn't override.
 * Requires orgSlug (needed for API calls) and interactive terminal.
 *
 * @param error - Any caught error
 * @returns true if the error is a SeerError eligible for a trial prompt
 */
export function isTrialEligible(error: unknown): error is SeerError {
  return (
    error instanceof SeerError &&
    TRIAL_ELIGIBLE_REASONS.has(error.reason) &&
    error.orgSlug !== undefined &&
    isatty(0)
  );
}

/**
 * Attempt to offer and start a Seer trial.
 *
 * Flow:
 * 1. Check trial availability via API (graceful failure → return false)
 * 2. Show context message + prompt user for confirmation
 * 3. Start the trial via API
 *
 * Uses consola logger for all output (not raw stderr writes).
 *
 * @param orgSlug - Organization slug
 * @param reason - The SeerError reason (for context message)
 * @returns true if trial was started successfully, false otherwise
 */
export async function promptAndStartTrial(
  orgSlug: string,
  reason: SeerErrorReason
): Promise<boolean> {
  const log = logger.withTag("seer");

  // 1. Check trial availability (graceful failure → return false)
  let trial: ReturnType<typeof findAvailableTrial>;
  try {
    const trials = await getProductTrials(orgSlug);
    trial = findAvailableTrial(trials, "seer");
  } catch (error) {
    log.debug("Failed to check trial availability", error);
    return false;
  }

  if (!trial) {
    // No trial available (expired or already used)
    log.info(
      "No Seer trial available. If you've already used your trial, " +
        "consider upgrading your plan to continue using Seer."
    );
    log.info(`  ${buildBillingUrl(orgSlug, "seer")}`);
    return false;
  }

  // 2. Show context and prompt
  const context = REASON_CONTEXT[reason];
  if (context) {
    log.info(context);
  }

  const daysText = trial.lengthDays ? `${trial.lengthDays}-day ` : "";
  const confirmed = await log.prompt(
    `A free ${daysText}Seer trial is available. Start trial?`,
    { type: "confirm", initial: true }
  );

  // Symbol(clack:cancel) is truthy — strict equality check
  if (confirmed !== true) {
    return false;
  }

  // 3. Start trial using the category from the available trial
  try {
    log.info("Starting Seer trial...");
    await startProductTrial(orgSlug, trial.category);
    log.success("Seer trial activated!");
    return true;
  } catch (error) {
    log.debug("Trial start API call failed", error);
    log.warn(
      "Failed to start trial. Please try again or visit your Sentry settings:"
    );
    log.warn(`  ${buildBillingUrl(orgSlug, "seer")}`);
    log.warn("If the problem persists, contact support@sentry.io for help.");
    return false;
  }
}
