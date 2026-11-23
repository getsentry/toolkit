/** User-facing errors for a child process that could not be started. */

import { existsSync } from "node:fs";
import {
  CliError,
  COMMAND_NOT_FOUND_FIELD,
  stringifyUnknown,
  ValidationError,
} from "./errors.js";
import { whichSync } from "./which.js";

/** The hint after "Command not found", e.g. `python` on Ubuntu. */
function notFoundHint(command: string): string {
  if (command === "python" && whichSync("python3")) {
    return "Did you mean python3?";
  }
  return "Check that it is installed and on your PATH.";
}

/**
 * Build the error for a command that `sentry local run` or `sentry monitor
 * run` could not start, from a `spawn()` throw or the child's `error` event.
 *
 * ENOENT means the command is not installed or not on PATH. That is the
 * user's environment, not a CLI bug, so it becomes a {@link ValidationError}
 * with field {@link COMMAND_NOT_FOUND_FIELD}, which `classifySilenced` keeps
 * out of Sentry issues (CLI-3NK). Other failures (EACCES, EINVAL, ...) keep
 * the errno message. A {@link CliError} is returned unchanged, such as the
 * line-break {@link ValidationError} from `spawnUserCommand`.
 *
 * Node also reports ENOENT when the spawn `cwd` is gone (e.g. the directory
 * was deleted), so that case gets its own error, which stays reported.
 *
 * @param command - The command the user asked to run, not the resolved
 *   target (on Windows that can be `cmd.exe`)
 * @param error - What `spawn()` threw or the child's `error` event gave
 * @param cwd - The `cwd` passed to `spawn()`, if any
 */
export function spawnFailureError(
  command: string,
  error: unknown,
  cwd?: string,
): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    if (cwd !== undefined && !existsSync(cwd)) {
      return new CliError(
        `Working directory no longer exists: ${cwd}\n\nRun the command again from a directory that exists.`,
      );
    }
    return new ValidationError(
      `Command not found: ${command}\n\n${notFoundHint(command)}`,
      COMMAND_NOT_FOUND_FIELD,
    );
  }
  return new CliError(
    `Failed to start "${command}": ${stringifyUnknown(error)}`,
  );
}
