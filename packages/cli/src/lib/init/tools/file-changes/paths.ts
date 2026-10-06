/**
 * Canonical path snapshots for the file-change engine.
 *
 * Preparation records the real root and destination. Apply recomputes both so
 * a retargeted project or ancestor symlink is treated as stale evidence.
 */

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/** Return a stable device/inode identity for an existing path when available. */
export async function resolvePathIdentity(
  absolutePath: string
): Promise<string | undefined> {
  try {
    const stats = await lstat(absolutePath, { bigint: true });
    return stats.ino === 0n ? undefined : `${stats.dev}:${stats.ino}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return;
    }
    throw error;
  }
}

/** Resolve an existing project root to the identity used during preparation. */
export function resolveCanonicalRoot(root: string): Promise<string> {
  return realpath(root);
}

/**
 * Resolve a destination even when its final components do not exist yet.
 * The returned path follows the nearest existing ancestor and appends the
 * missing suffix without mutating disk.
 */
export async function resolveCanonicalDestination(
  absolutePath: string
): Promise<string> {
  let existingPath = absolutePath;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(existingPath), ...missingSegments);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = path.dirname(existingPath);
      if (parent === existingPath) {
        throw error;
      }
      missingSegments.unshift(path.basename(existingPath));
      existingPath = parent;
    }
  }
}

/** Return true when a canonical destination remains inside its captured root. */
export function isCanonicalChild(root: string, destination: string): boolean {
  return destination === root || destination.startsWith(`${root}${path.sep}`);
}
