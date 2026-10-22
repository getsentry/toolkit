/**
 * Opt-in non-fatal failures for CI (`--allow-failure` / `SENTRY_ALLOW_FAILURE`).
 *
 * Carries over sentry-cli v3's escape hatch: when enabled, the CLI still
 * reports the error on stderr but exits `0`, so an optional Sentry step
 * (uploading source maps, creating a release) can't fail a build.
 *
 * Only the CLI binary applies this, from `startCli`. Library invocations
 * keep throwing so programmatic callers still see failures.
 */

import { getEnv } from "./env.js";
import { logger } from "./logger.js";
import { parseBoolValue } from "./parse-bool.js";

const log = logger.withTag("allow-failure");

/** Set by the `--allow-failure` global flag for the current process. */
const state = { flagEnabled: false };

/** Record that `--allow-failure` was passed. Called by the command wrapper. */
export function enableAllowFailure(): void {
  state.flagEnabled = true;
}

/** Reset the flag state. Test-only. */
export function resetAllowFailure(): void {
  state.flagEnabled = false;
}

/** Whether `--allow-failure` was passed or `SENTRY_ALLOW_FAILURE` is truthy. */
function isAllowFailureEnabled(): boolean {
  if (state.flagEnabled) {
    return true;
  }
  const value = getEnv().SENTRY_ALLOW_FAILURE;
  return value !== undefined && parseBoolValue(value) === true;
}

/**
 * Turn a non-zero `process.exitCode` into `0` when allow-failure is enabled.
 *
 * Runs after the command finished and its error was already printed, so the
 * failure stays visible in CI logs.
 */
export function applyAllowFailure(): void {
  const exitCode = Number(process.exitCode ?? 0);
  if (exitCode === 0 || !isAllowFailureEnabled()) {
    return;
  }
  log.warn(
    `Command failed with exit code ${exitCode}, exiting with 0 because --allow-failure or SENTRY_ALLOW_FAILURE is set.`,
  );
  process.exitCode = 0;
}
