/**
 * Replace a file's contents without ever leaving it half-written.
 *
 * Used where the CLI rewrites a user's build output in place (wasm modules,
 * sourcemaps). A plain `writeFile` truncates first, so a full disk or a kill
 * mid-write leaves a corrupt artifact; writing a sibling and renaming it over
 * the target is atomic on the same filesystem. The original's mode is kept so
 * an executable or read-only-for-others file stays that way.
 */

import { randomBytes } from "node:crypto";
import { rename, rm, stat, writeFile } from "node:fs/promises";

/**
 * Atomically replace `path` with `data`.
 *
 * @param path - Existing file to replace
 * @param data - New contents
 */
export async function replaceFile(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const { mode } = await stat(path);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data, { mode });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}
