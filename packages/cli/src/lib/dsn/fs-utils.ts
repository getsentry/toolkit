/**
 * File System Utilities for DSN Detection
 *
 * Shared utilities for handling file system errors during scanning.
 */

import { stat } from "node:fs/promises";
import { reportCliError } from "../error-reporting.js";
import { logger } from "../logger.js";

const log = logger.withTag("fs");

/**
 * System error codes that point at a CLI bug rather than the user's
 * filesystem: we leaked descriptors, exhausted memory, or used a closed fd.
 * These stay reported even though they come from a syscall.
 */
const REPORTABLE_SYSTEM_ERROR_CODES: ReadonlySet<string> = new Set([
  "EMFILE",
  "ENFILE",
  "ENOMEM",
  "EBADF",
]);

/**
 * POSIX errno names (`EIO`, `ENOTCONN`, …) plus libuv's `UNKNOWN`. Excludes
 * Node's own `ERR_*` codes, which signal misuse of an API by our code.
 */
const ERRNO_CODE_RE = /^(E[A-Z0-9]+|UNKNOWN)$/;

/**
 * Check if an error is an expected file system error that should be ignored.
 *
 * Scanning is best-effort: any directory or file the OS refuses to read is
 * skipped. An OS errno describes the user's machine — missing files,
 * permissions, virtual filesystems (`/proc` → EINVAL), and unhealthy
 * network, cloud, or FUSE mounts (EIO, ENOTCONN, ETIMEDOUT, ECANCELED,
 * EINTR, macOS "Unknown system error -11", …). None of these are
 * actionable for the CLI, and allowlisting them one errno at a time kept
 * missing the next one. Only {@link REPORTABLE_SYSTEM_ERROR_CODES} and
 * non-errno errors (bugs in our own code) are reported to Sentry.
 *
 * @param error - The error to check
 * @returns True if the error is expected and should be ignored
 */
function isIgnorableFileError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" && ERRNO_CODE_RE.test(code)) {
    return !REPORTABLE_SYSTEM_ERROR_CODES.has(code);
  }
  // Node.js may omit the code entirely for non-POSIX kernel errors; fall back
  // to matching the message prefix that macOS / libuv uses in that case.
  return error.message.startsWith("Unknown system error");
}

/**
 * Handle a file system error by either ignoring it (for expected errors)
 * or capturing it to Sentry (for unexpected errors).
 *
 * Ignored errors other than ENOENT are logged at debug level so
 * `--verbose` explains why a directory or file was skipped.
 *
 * @param error - The error that occurred
 * @param context - Additional context for Sentry (e.g., file path, operation)
 */
export function handleFileError(
  error: unknown,
  context: { operation: string; path?: string },
): void {
  if (!isIgnorableFileError(error)) {
    reportCliError(error, {
      tags: {
        operation: context.operation,
      },
      extra: {
        path: context.path,
      },
    });
    return;
  }
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    log.debug(
      `${context.operation}: skipped unreadable path (${(error as Error).message})`,
    );
  }
}

/**
 * Check if a path points to a regular file (not a FIFO, socket, device, etc.).
 *
 * Named pipes (FIFOs) — commonly used by 1Password to stream secrets via
 * symlinked `.env` files — cause `readFile()` to block indefinitely
 * waiting for a writer. This guard uses `stat()`, which follows symlinks
 * and inspects file type without performing the blocking read, so a
 * symlink → FIFO is correctly detected.
 *
 * @param filePath - Absolute path to check
 * @param operation - Logical operation name for unexpected stat error reporting
 * @returns True if the path is a regular file safe to read, false otherwise
 */
export async function isRegularFile(
  filePath: string,
  operation = "isRegularFile",
): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch (error) {
    handleFileError(error, { operation, path: filePath });
    return false;
  }
}
