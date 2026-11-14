/**
 * Shared file reading for `debug-files` commands.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ValidationError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";

const log = logger.withTag("debug-files.read-file");

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
        "path",
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Cannot read file '${path}': ${msg}`, "path");
  }
}

/**
 * Read a source file for source-bundle resolution.
 *
 * A debug file names the sources it was compiled from, but those sources are
 * often absent on the machine running the upload. A missing one is expected, so
 * it is skipped rather than failing the bundle.
 *
 * @param sourcePath - Path the debug file references.
 * @returns The contents, or `null` when the file is not available locally.
 */
export function readSourceFile(sourcePath: string): Uint8Array | null {
  try {
    return readFileSync(sourcePath);
  } catch (err) {
    log.debug(`Source file not available, skipping: ${sourcePath}`, err);
    return null;
  }
}
