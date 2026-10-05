/**
 * DSN scanner preset for `walkFiles`.
 *
 * Expresses the policy the DSN scanner applies: a depth-3 cap, full
 * DSN skip list (including test/fixture dirs), monorepo-boundary
 * depth reset, and the `TEXT_EXTENSIONS` allowlist.
 *
 * Lives in `dsn/` rather than `scan/` so the core scanner module
 * stays policy-free. Other callers (the init wizard, future features)
 * bring their own presets.
 */

import type { WalkOptions } from "../scan/index.js";
import {
  DEFAULT_SKIP_DIRS,
  DSN_ADDITIONAL_SKIP_DIRS,
  isMonorepoPackageDir,
  TEXT_EXTENSIONS,
} from "../scan/index.js";

/**
 * DSN scanner depth limit. `maxDepth` caps directory descent; files
 * inside the last-entered directory are still yielded regardless. So
 * with `maxDepth: 3` + the monorepo descent hook, the deepest yielded
 * files look like `packages/foo/a/b/c/file.ts` — three directory
 * levels past the package boundary.
 */
export const DSN_MAX_DEPTH = 3;

/**
 * Build a `WalkOptions` recipe that produces DSN-scanner-equivalent
 * behavior. Callers provide `cwd`; this helper fills in the rest.
 */
export function dsnScanOptions(): Omit<WalkOptions, "cwd"> {
  return {
    extensions: TEXT_EXTENSIONS,
    alwaysSkipDirs: [...DEFAULT_SKIP_DIRS, ...DSN_ADDITIONAL_SKIP_DIRS],
    maxDepth: DSN_MAX_DEPTH,
    descentHook: dsnDescentHook,
    nestedGitignore: true,
    respectGitignore: true,
    hidden: true,
  };
}

/**
 * Entering a monorepo package dir resets the depth counter, giving
 * each package its own depth-3 budget. Exported for isolated tests.
 */
export function dsnDescentHook(relPath: string, currentDepth: number): number {
  return isMonorepoPackageDir(relPath) ? 0 : currentDepth + 1;
}
