/**
 * FIFO-safe file-read helper for user-controlled paths.
 *
 * Named pipes (FIFOs), commonly created by 1Password's `.env` symlink
 * integration, cause `readFile()` to block indefinitely waiting for a
 * writer. Any read of a path under the user's project tree or home
 * directory needs a `stat`-based regular-file check first.
 *
 * Prefer this helper over calling `isRegularFile` + `readFile()` by
 * hand: a single call, consistent error handling, no way to forget
 * the guard.
 */

import { readFile } from "node:fs/promises";
import { handleFileError, isRegularFile } from "./dsn/fs-utils.js";

/**
 * Read a file's text content, returning `null` when the path is:
 * - missing / inaccessible (ENOENT / EACCES / EPERM / EISDIR / ENOTDIR)
 * - not a regular file (FIFO, socket, device, symlink to any of these)
 * - any other expected I/O-level failure routed through
 *   {@link handleFileError}
 *
 * Unexpected errors are captured to Sentry via `handleFileError` and
 * also return `null`, so callers don't need their own try/catch.
 *
 * @param filePath - Absolute path to read.
 * @param operation - Logical operation name, reported to Sentry when a
 *   stat or read fails unexpectedly. Keep it short and specific (e.g.,
 *   `"sentryclirc.read"`, `"read-files.tool"`).
 */
export async function safeReadFile(
  filePath: string,
  operation: string
): Promise<string | null> {
  if (!(await isRegularFile(filePath, `${operation}.stat`))) {
    return null;
  }
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    handleFileError(error, { operation, path: filePath });
    return null;
  }
}
