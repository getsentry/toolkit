/**
 * Shared async generator for walking up a directory tree.
 *
 * Yields each directory from `startDir` up toward the filesystem root.
 * Resolves symlinks via `realpath` to detect cycles (e.g., a symlink
 * pointing back down the tree).
 *
 * Used by `.sentryclirc` config loading and project-root detection.
 */

import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Walk up from `startDir` toward the filesystem root, yielding each
 * directory path along the way.
 *
 * Stops at the filesystem root or on a symlink cycle. The caller can
 * `break` out of the loop early (e.g., when all needed data is found,
 * or when a stop boundary like `homedir()` is reached).
 *
 * @param startDir - Directory to start walking from
 * @yields Absolute directory paths, starting with `startDir`
 */
export async function* walkUpFrom(startDir: string): AsyncGenerator<string> {
  const seen = new Set<string>();
  let current = resolve(startDir);

  while (true) {
    let real: string;
    try {
      real = await realpath(current);
    } catch {
      // Can't resolve (broken symlink, permission denied) — stop walking
      break;
    }
    if (seen.has(real)) {
      break;
    }
    seen.add(real);

    yield current;

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}
