/**
 * Shared constants for the `scan` module.
 *
 * These values are deliberately policy-free defaults for a general-purpose
 * scanner. Callers that need stricter DSN-style filtering should spread
 * `DSN_ADDITIONAL_SKIP_DIRS` into their `alwaysSkipDirs` option.
 *
 * Single source of truth: `src/lib/dsn/code-scanner.ts` previously owned
 * `TEXT_EXTENSIONS`, `MAX_FILE_SIZE`, `CONCURRENCY_LIMIT`, `normalizePath`,
 * and `isMonorepoPackageDir`. Once PR 3 lands, `code-scanner.ts` re-imports
 * from here instead of duplicating.
 */

import { availableParallelism } from "node:os";
import path from "node:path";
// Re-exported below so scan callers don't have to reach into `dsn/`.
import { MONOREPO_ROOTS as DSN_MONOREPO_ROOTS } from "../dsn/types.js";

/**
 * File extensions the walker classifies as text without running the
 * 8 KB NUL-byte sniff. Files with extensions outside this set fall
 * through to `readHeadAndSniff()` which inspects the first 8 KB.
 *
 * Lifted verbatim from `src/lib/dsn/code-scanner.ts` so that PR 3 can
 * swap the DSN scanner over to this module with no behavior change.
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  // JavaScript/TypeScript ecosystem
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".astro",
  ".vue",
  ".svelte",
  // Python
  ".py",
  // Go
  ".go",
  // Ruby
  ".rb",
  ".erb",
  // PHP
  ".php",
  // JVM languages
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".groovy",
  // .NET languages
  ".cs",
  ".fs",
  ".vb",
  // Rust
  ".rs",
  // Swift/Objective-C
  ".swift",
  ".m",
  ".mm",
  // Dart/Flutter
  ".dart",
  // Elixir/Erlang
  ".ex",
  ".exs",
  ".erl",
  // Lua
  ".lua",
  // Config/data formats
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".properties",
  ".config",
]);

/**
 * Default directories the walker always skips, independent of any user
 * `.gitignore`. Limited to VCS + common build outputs — explicitly NOT
 * including test / fixture / IDE dirs, because a general-purpose scanner
 * has no business skipping those. Callers like the DSN detector, which
 * have stricter policy, combine this list with `DSN_ADDITIONAL_SKIP_DIRS`.
 */
export const DEFAULT_SKIP_DIRS: readonly string[] = [
  // Version control
  ".git",
  ".hg",
  ".svn",
  // Node / JS
  "node_modules",
  "bower_components",
  ".pnpm-store",
  ".parcel-cache",
  // Python
  "__pycache__",
  "venv",
  ".venv",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  // General build outputs
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".angular",
  ".serverless",
  ".dart_tool",
  ".build",
  "DerivedData",
  "obj",
  "CMakeFiles",
  "cmake-build-debug",
  "cmake-build-release",
  // Go / Ruby / Gradle
  "vendor",
  ".gradle",
  ".bundle",
  // Coverage + caches
  "coverage",
  "htmlcov",
  ".cache",
  ".turbo",
];

/**
 * DSN-specific extras that the DSN scanner needs on top of `DEFAULT_SKIP_DIRS`.
 * These are listed separately because a general grep caller shouldn't skip
 * `test/` / `fixtures/` (users search inside tests all the time), but the
 * DSN scanner does (to avoid picking up fixture DSNs).
 */
export const DSN_ADDITIONAL_SKIP_DIRS: readonly string[] = [
  // IDE / editor
  ".idea",
  ".vscode",
  ".cursor",
  // Test directories with fixture DSNs
  "test",
  "tests",
  "__mocks__",
  "fixtures",
  "__fixtures__",
  // OS / app-data and credential directories. Defence in depth: a DSN
  // scan that falls back to $HOME (or runs anywhere near one of these)
  // must never descend into OS app-data or secret stores. Reaching them
  // trips security monitoring and opens sensitive files for the 8 KB
  // content sniff. See getsentry/cli#1590.
  // macOS / Windows OS app-data
  "Library",
  "AppData",
  // SSH / GPG / cloud credentials
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  // Password managers / secret stores
  ".password-store",
  ".gpg",
  // XDG / user config + local data
  ".config",
  ".local",
];

/**
 * Skip files larger than this during walks. 256 KB covers source files
 * comfortably while keeping single-file `readText` within budget.
 *
 * Callers that need to accept larger files can override via
 * `WalkOptions.maxFileSize`.
 */
export const MAX_FILE_SIZE = 256 * 1024;

/**
 * Concurrency ceiling for per-file work outside the walker itself
 * (binary sniffing, content reading, regex matching via
 * `mapFilesConcurrent`). The walker itself is a sequential generator;
 * this bounds the parallel fan-out of its consumers.
 *
 * ### Tuning rationale (empirical, workload-dependent)
 *
 * This value is the result of two competing measurements on a 4-core
 * box. The honest summary: **the "optimal" concurrency depends on the
 * caller's shape**, and no single default is right for every workload.
 *
 * 1. **Walker-fed streaming** (DSN scanner, init-wizard grep over a
 *    repo): the walker's serial `readdir` descent is the dominant
 *    cost. Workers never starve; conc≥2 is enough; conc≈4-8 is best
 *    empirically. Higher values add tiny scheduling overhead without
 *    more useful work.
 * 2. **Pure per-file I/O** (pre-listed file set, no walker): the
 *    knee is at conc≈16 on raw reads, ≈32 on read+regex. libuv's
 *    threadpool + async fs can keep many more in-flight tasks alive
 *    than CPU count would suggest, because each task spends most of
 *    its time awaiting I/O.
 *
 * We split the difference and tie the default to `availableParallelism`
 * with floors/caps:
 *   - 1-2 cores → 2  (tiny CI runners)
 *   - 4 cores   → 4
 *   - 8 cores   → 8
 *   - 16+ cores → 16 (capped)
 *
 * Optimizing for the walker-fed case costs ~1-2% on pure-I/O; the
 * reverse costs ~15% on walker-fed. Walker-fed is the real-world
 * workload (every current caller uses the walker). Callers with
 * known-pure-I/O workloads should override via
 * `WalkOptions.concurrency` / `GrepOptions.concurrency`.
 *
 * ### History
 *
 * - Pre-PR: hardcoded 50, inherited with no measurement. Fine for
 *   walker-fed, wastes scheduling budget.
 * - PR 3.5 first attempt: tied to `availableParallelism()`. Correct
 *   direction, but the "knee" analysis conflated walker dominance
 *   with actual I/O parallelism limits.
 * - PR 3.5 second attempt: `cores × 4` capped at 32 (8 floor).
 *   Microbench-optimal but regressed `scanCodeForDsns` ~15% because
 *   the microbench excluded the walker which is the actual bottleneck.
 * - Now: `availableParallelism` with 2/16 clamps. Measured best on
 *   the walker-fed workload; "suboptimal" on pure I/O but close
 *   enough (within a few ms).
 */
export const CONCURRENCY_LIMIT = Math.min(
  16,
  Math.max(2, availableParallelism())
);

/**
 * Byte length read from the head of a file to classify binary-ness.
 * Standard NUL-byte heuristic used by rg, git, grep, and file(1).
 */
export const BINARY_SNIFF_BYTES = 8192;

/**
 * Re-export MONOREPO_ROOTS so downstream scan-module consumers don't have
 * to cross into the `dsn/` package.
 */
export const MONOREPO_ROOTS = DSN_MONOREPO_ROOTS;

/**
 * Normalize path separators to forward slashes. No-op on POSIX,
 * `\\` → `/` on Windows. Required for:
 *   1. The `ignore` package (which expects forward slashes)
 *   2. Monorepo-boundary detection (splits on "/")
 *   3. Consistent relativePath values on `WalkEntry`
 */
export const normalizePath: (p: string) => string =
  path.sep === path.posix.sep
    ? (x) => x
    : (x) => x.replaceAll(path.sep, path.posix.sep);

/**
 * True if `relativePath` names a monorepo package directory — exactly
 * two segments where the first is one of `MONOREPO_ROOTS`
 * (e.g., "packages/frontend", "apps/server").
 *
 * Not used by the core walker (which is policy-free), but exported for
 * consumers like the DSN scanner that want to reset their depth counter
 * at package boundaries.
 */
export function isMonorepoPackageDir(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return (
    segments.length === 2 &&
    MONOREPO_ROOTS.includes(segments[0] as (typeof MONOREPO_ROOTS)[number])
  );
}
