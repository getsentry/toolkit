/**
 * Shared `--wait` / `--wait-for` handling for `debug-files` commands.
 *
 * Uploading is only half the job: the server still has to assemble and index
 * what it received. Commands that upload therefore offer the same pair of
 * flags, and they have to agree on what the pair means.
 */

import { DEBUG_FILES_MAX_WAIT_MS } from "../../lib/api/debug-files.js";
import { ValidationError } from "../../lib/errors.js";

/** The wait flags, as a command declares them. */
export type WaitFlags = {
  /** Wait for server-side processing, using the default deadline. */
  wait?: boolean;
  /** Wait for server-side processing, in seconds. */
  "wait-for"?: number;
};

/** Whether to wait, and for how long. */
export type WaitMode = {
  wait: boolean;
  maxWaitMs: number;
};

/**
 * Resolve the wait mode and deadline from the flags.
 *
 * @throws {ValidationError} If both flags are set, or `--wait-for` is invalid.
 */
export function resolveWaitMode(flags: WaitFlags): WaitMode {
  const waitFor = flags["wait-for"];
  if (flags.wait && waitFor !== undefined) {
    throw new ValidationError(
      "--wait and --wait-for cannot be combined",
      "wait",
    );
  }
  if (waitFor !== undefined) {
    if (!Number.isFinite(waitFor) || waitFor <= 0) {
      throw new ValidationError(
        "--wait-for must be a positive number of seconds",
        "wait-for",
      );
    }
    return { wait: true, maxWaitMs: Math.round(waitFor * 1000) };
  }
  return { wait: Boolean(flags.wait), maxWaitMs: DEBUG_FILES_MAX_WAIT_MS };
}
