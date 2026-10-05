/**
 * File System Utilities for DSN Detection
 *
 * Shared utilities for handling file system errors during scanning.
 */

import { stat } from "node:fs/promises";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";

/**
 * Check if an error is an expected file system error that should be silently ignored.
 *
 * Expected errors during file scanning:
 * - ENOENT: File or directory does not exist
 * - EACCES: Permission denied (e.g., no read access)
 * - EPERM: Operation not permitted (e.g., file locked, or system-level restriction)
 * - EISDIR: Path is a directory, not a file (e.g., `.env/` directory instead of `.env` file)
 * - ENOTDIR: A path component is not a directory (e.g., `/file.txt/child`)
 * - EINVAL: Invalid argument (e.g., scandir on a special/virtual filesystem entry like /proc paths)
 * - ELOOP: Too many symbolic links (e.g., cyclic symlink encountered during scan)
 * - ETIMEDOUT: Connection timed out (e.g., transient read on a network or cloud-mounted filesystem)
 * - Unknown system error: Non-POSIX kernel errors on macOS (e.g., errno -11 / EAGAIN on .trace bundles)
 *   that Node.js cannot map to a standard code string
 *
 * All other errors are unexpected and should be reported to Sentry.
 *
 * @param error - The error to check
 * @returns True if the error is expected and should be ignored
 */
function isIgnorableFileError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (
    code === "ENOENT" ||
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EISDIR" ||
    code === "ENOTDIR" ||
    code === "EINVAL" ||
    code === "ELOOP" ||
    code === "ETIMEDOUT" ||
    // macOS surfaces non-POSIX kernel errors (e.g. errno -11 on .trace bundles)
    // as "Unknown system error -N" without a standard POSIX code string.
    code === "UNKNOWN"
  ) {
    return true;
  }
  // Node.js may omit the code entirely for non-POSIX kernel errors; fall back
  // to matching the message prefix that macOS / libuv uses in that case.
  return error.message.startsWith("Unknown system error");
}

/**
 * Handle a file system error by either ignoring it (for expected errors)
 * or capturing it to Sentry (for unexpected errors).
 *
 * @param error - The error that occurred
 * @param context - Additional context for Sentry (e.g., file path, operation)
 */
export function handleFileError(
  error: unknown,
  context: { operation: string; path?: string }
): void {
  if (!isIgnorableFileError(error)) {
    Sentry.captureException(error, {
      tags: {
        operation: context.operation,
      },
      extra: {
        path: context.path,
      },
    });
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
  operation = "isRegularFile"
): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    return stats.isFile();
  } catch (error) {
    handleFileError(error, { operation, path: filePath });
    return false;
  }
}
