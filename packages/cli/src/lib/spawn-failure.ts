/** User-facing errors for a child process that could not be started. */

import { CliError, ValidationError } from "./errors.js";

/**
 * Build the error for a child process that failed to start (the child's
 * `error` event, used by `sentry local run` and `sentry monitor run`).
 *
 * ENOENT means the command is not installed or not on PATH. That is the
 * user's environment, not a CLI bug, so it becomes a {@link ValidationError}
 * with field `command.not_found`, which `classifySilenced` keeps out of
 * Sentry issues (CLI-3NK). Other failures (EACCES, EINVAL, ...) keep the
 * errno message.
 *
 * @param command - The executable the CLI tried to spawn
 * @param error - The error from the child's `error` event
 */
export function spawnFailureError(command: string, error: Error): CliError {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return new ValidationError(
      `Command not found: ${command}\n\nCheck that it is installed and on your PATH.`,
      "command.not_found",
    );
  }
  return new CliError(`Failed to start "${command}": ${error.message}`);
}
