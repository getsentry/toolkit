/**
 * Shared file reading for `debug-files` commands.
 */

import { readFile } from "node:fs/promises";
import { ValidationError } from "../../lib/errors.js";

/**
 * Read a debug information file from disk with descriptive error handling.
 *
 * @param path - Path to the file.
 * @returns The file contents.
 * @throws {ValidationError} On ENOENT, EISDIR, or other read failures.
 */
export async function readDebugFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ValidationError(`File '${path}' does not exist.`, "path");
    }
    if (code === "EISDIR") {
      throw new ValidationError(
        `Path '${path}' is a directory, not a debug information file.`,
        "path"
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Cannot read file '${path}': ${msg}`, "path");
  }
}
