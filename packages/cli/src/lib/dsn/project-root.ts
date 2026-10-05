/**
 * Project Root Detection
 *
 * Walks up from starting directory to find project root, optionally
 * detecting DSN along the way for early exit.
 *
 * Priority:
 * 1. .env with SENTRY_DSN → immediate return
 * 2. VCS/CI markers → definitive repo root (stop walking)
 * 3. Language markers → closest to cwd wins
 * 4. Build system markers → last resort
 *
 * Stops at: home directory or filesystem root
 */

import { opendir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import pLimit from "p-limit";
import picomatch from "picomatch";
import { anyTrue } from "../promises.js";
import {
  applyGlobalFallbacks,
  applySentryCliRcDir,
  createSentryCliRcConfig,
  CONFIG_FILENAME as SENTRYCLIRC_FILENAME,
  type SentryCliRcConfig,
  setSentryCliRcCache,
} from "../sentryclirc.js";
import { withFsSpan, withTracingSpan } from "../telemetry.js";
import { walkUpFrom } from "../walk-up.js";
import { ENV_FILES, extractDsnFromEnvContent } from "./env-file.js";
import { handleFileError, isRegularFile } from "./fs-utils.js";
import { createDetectedDsn } from "./parser.js";
import type { DetectedDsn } from "./types.js";

/** Why a directory was chosen as project root */
export type ProjectRootReason =
  | "env_dsn" // Found .env with SENTRY_DSN
  | "vcs" // Version control (.git, .hg, etc.)
  | "ci" // CI/CD markers (.github, etc.)
  | "editorconfig" // .editorconfig with root=true
  | "language" // Language/package marker
  | "build_system" // Build system marker
  | "fallback"; // No markers found, using cwd

/** Result of project root detection */
export type ProjectRootResult = {
  /** The determined project root directory */
  projectRoot: string;
  /** DSN found in .env while walking up (early exit) */
  foundDsn?: DetectedDsn;
  /** Why this directory was chosen as root */
  reason: ProjectRootReason;
  /** Number of directories traversed to find root */
  levelsTraversed: number;
};

/** VCS directories - definitive repo root */
const VCS_MARKERS = [
  ".git",
  ".hg",
  ".svn",
  ".bzr",
  "_darcs",
  ".fossil",
  ".pijul",
] as const;

/** CI/CD markers - definitive repo root */
const CI_MARKERS = [
  ".github",
  ".gitlab-ci.yml",
  ".circleci",
  "Jenkinsfile",
  ".travis.yml",
  "azure-pipelines.yml",
  ".buildkite",
  "bitbucket-pipelines.yml",
  ".drone.yml",
  ".woodpecker.yml",
  ".forgejo",
  ".gitea",
] as const;

/** Language/package markers - strong project boundary */
const LANGUAGE_MARKERS = [
  // Sentry CLI config — treated as a project boundary (not definitive root,
  // so the walk continues past it to find VCS markers in monorepos)
  SENTRYCLIRC_FILENAME,
  // JavaScript/Node ecosystem
  "package.json",
  "deno.json",
  "deno.jsonc",
  // Python
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  // Go
  "go.mod",
  "go.work",
  // Rust
  "Cargo.toml",
  // Ruby
  "Gemfile",
  // PHP
  "composer.json",
  // Java/JVM
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "build.sbt",
  // .NET
  "global.json",
  // Swift
  "Package.swift",
  // Elixir
  "mix.exs",
  // Dart/Flutter
  "pubspec.yaml",
  // Haskell
  "stack.yaml",
  "cabal.project",
  // OCaml
  "dune-project",
  // Zig
  "build.zig",
  "build.zig.zon",
  // Clojure
  "project.clj",
  "deps.edn",
] as const;

/** Glob patterns for language markers that need wildcard matching */
const LANGUAGE_MARKER_GLOBS = [
  "*.sln",
  "*.csproj",
  "*.fsproj",
  "*.vbproj",
  "*.cabal",
  "*.opam",
  "*.nimble",
] as const;

/** Build system markers - last resort */
const BUILD_SYSTEM_MARKERS = [
  "Makefile",
  "GNUmakefile",
  "makefile",
  "CMakeLists.txt",
  "BUILD",
  "BUILD.bazel",
  "WORKSPACE",
  "WORKSPACE.bazel",
  "MODULE.bazel",
  "meson.build",
  "Justfile",
  "justfile",
  "Taskfile.yml",
  "Taskfile.yaml",
  "SConstruct",
  "xmake.lua",
  "premake5.lua",
  "premake4.lua",
  "wscript",
  "Earthfile",
] as const;

/**
 * Regex for detecting root=true in .editorconfig.
 * Leading whitespace is valid per EditorConfig spec (allows indentation).
 */
const EDITORCONFIG_ROOT_REGEX = /^\s*root\s*=\s*true\s*$/im;

/**
 * Maximum concurrent stat() calls across all project-root detection work.
 *
 * Shared across every anyExists() call so the budget bounds total FD
 * pressure, not per-group pressure. processDirectoryLevel fires 4
 * parallel anyExists() groups (VCS: 7, CI: 12, language: 30, build: 19 —
 * up to 68 stat() calls combined) and this limiter caps their combined
 * concurrency.
 *
 * macOS kqueue has a ~256 FD limit per process; exceeding it returns
 * EINVAL (CLI-19A). 32 leaves generous headroom while keeping the
 * common-case marker checks (VCS: 7, CI: 12) fully parallel. Matches
 * the shared pLimit pattern in response-cache.ts.
 */
export const STAT_CONCURRENCY = 32;
const statLimit = pLimit(STAT_CONCURRENCY);

/**
 * Check if a path exists (file or directory) using stat.
 */
async function pathExists(filePath: string): Promise<boolean> {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if any of the given paths exist in a directory.
 * Runs checks in parallel and resolves as soon as any returns true.
 *
 * The shared statLimit limiter caps total concurrent stat() calls across
 * all marker groups (VCS, CI, language, build) to avoid exhausting the
 * OS file descriptor table (kqueue on macOS, epoll on Linux).
 *
 * @param dir - Directory to check
 * @param names - Array of file/directory names to check
 * @returns True if any path exists
 */
function anyExists(dir: string, names: readonly string[]): Promise<boolean> {
  return anyTrue(names, (name) => statLimit(() => pathExists(join(dir, name))));
}

/**
 * Check if any files matching glob patterns exist in a directory.
 * Uses `opendir` to lazily stream directory entries and exits on first match
 * without reading the entire directory. Matches via synchronous
 * `picomatch` (no async I/O, event-loop safe).
 *
 * @param dir - Directory to check
 * @param patterns - Glob patterns to match
 * @returns True if any matching file exists
 */
async function anyGlobMatches(
  dir: string,
  patterns: readonly string[]
): Promise<boolean> {
  // Bun's opendir() may not throw on a missing directory — the error
  // surfaces when iterating. Wrap the full open+iterate in one try/catch.
  // No explicit handle.close() needed: for-await-of auto-closes the Dir
  // handle when the loop exits (including early return or break).
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    // Pre-compile matchers outside the loop to avoid recompiling per entry.
    const matchers = patterns.map((p) => picomatch(p, { dot: true }));
    for await (const entry of await opendir(dir)) {
      if (entry.isFile() && matchers.some((m) => m(entry.name))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if .editorconfig exists and contains root=true.
 * Reads file directly and handles ENOENT gracefully.
 *
 * @param dir - Directory to check
 * @returns True if .editorconfig with root=true found
 */
async function checkEditorConfigRoot(dir: string): Promise<boolean> {
  const editorConfigPath = join(dir, ".editorconfig");
  try {
    // Guard: skip non-regular files (FIFOs, sockets, etc.) that would block
    if (
      !(await isRegularFile(editorConfigPath, "checkEditorConfigRoot.stat"))
    ) {
      return false;
    }
    const content = await readFile(editorConfigPath, "utf-8");
    return EDITORCONFIG_ROOT_REGEX.test(content);
  } catch (error) {
    handleFileError(error, {
      operation: "checkEditorConfigRoot",
      path: editorConfigPath,
    });
    return false;
  }
}

/**
 * Determine the type of repo root marker found.
 * Returns in priority order: VCS > CI > editorconfig.
 *
 * Note: This only handles "definitive" repo root markers (VCS, CI, editorconfig).
 * Language and build markers are handled separately in walkUpDirectories() because
 * they indicate project boundaries but don't definitively mark the repository root.
 */
function getRepoRootType(
  hasVcs: boolean,
  hasCi: boolean,
  hasEditorConfigRoot: boolean
): "vcs" | "ci" | "editorconfig" | undefined {
  if (hasVcs) {
    return "vcs";
  }
  if (hasCi) {
    return "ci";
  }
  if (hasEditorConfigRoot) {
    return "editorconfig";
  }
  return;
}

/**
 * Check if directory has VCS or CI/CD markers (definitive repo root)
 *
 * @param dir - Directory to check
 * @returns Object with found status and marker type
 */
export function hasRepoRootMarker(
  dir: string
): Promise<{ found: boolean; type?: "vcs" | "ci" | "editorconfig" }> {
  return withFsSpan("hasRepoRootMarker", async () => {
    // Check all marker types in parallel
    const [hasVcs, hasCi, hasEditorConfigRoot] = await Promise.all([
      anyExists(dir, VCS_MARKERS),
      anyExists(dir, CI_MARKERS),
      checkEditorConfigRoot(dir),
    ]);

    const type = getRepoRootType(hasVcs, hasCi, hasEditorConfigRoot);
    return type ? { found: true, type } : { found: false };
  });
}

/**
 * Check if directory has language/package markers
 *
 * @param dir - Directory to check
 * @returns True if any language marker found
 */
export function hasLanguageMarker(dir: string): Promise<boolean> {
  return withFsSpan("hasLanguageMarker", async () => {
    // Check exact filenames first (more common), then glob patterns
    if (await anyExists(dir, LANGUAGE_MARKERS)) {
      return true;
    }
    return anyGlobMatches(dir, LANGUAGE_MARKER_GLOBS);
  });
}

/**
 * Check if directory has build system markers
 *
 * @param dir - Directory to check
 * @returns True if any build system marker found
 */
export function hasBuildSystemMarker(dir: string): Promise<boolean> {
  return withFsSpan("hasBuildSystemMarker", async () =>
    anyExists(dir, BUILD_SYSTEM_MARKERS)
  );
}

/**
 * Check .env files in a directory for SENTRY_DSN.
 * Reads files directly and handles ENOENT gracefully.
 *
 * @param dir - Directory to check
 * @returns Detected DSN or null
 */
function checkEnvForDsn(dir: string): Promise<DetectedDsn | null> {
  return withFsSpan("checkEnvForDsn", async () => {
    // Check env files in priority order, stop on first DSN found
    for (const filename of ENV_FILES) {
      const filePath = join(dir, filename);
      try {
        // Guard: skip non-regular files (FIFOs, sockets, etc.) that would block.
        // 1Password streams secrets via symlinked named pipes; Bun.file().text()
        // blocks indefinitely on these.
        if (!(await isRegularFile(filePath, "checkEnvForDsn.stat"))) {
          continue;
        }
        const content = await readFile(filePath, "utf-8");
        const dsn = extractDsnFromEnvContent(content);
        if (dsn) {
          return createDetectedDsn(dsn, "env_file", filename);
        }
      } catch (error) {
        handleFileError(error, { operation: "checkEnvForDsn", path: filePath });
      }
    }
    return null;
  });
}

/**
 * Get the stop boundary for project root search.
 * Returns home directory if it exists, otherwise filesystem root.
 */
export function getStopBoundary(): string {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return homedir();
  } catch {
    return "/";
  }
}

/**
 * True when `dir` is the home directory or an ancestor of it (e.g. `/`,
 * `/Users`, `$HOME`). Used to suppress the downward DSN scan when project
 * root detection fell back to a directory at/above home — scanning down
 * from there reaches OS app-data and credential dirs (`~/Library`, `~/.ssh`,
 * `~/.aws`, …) that must never be touched.
 */
export function isHomeOrAncestor(dir: string): boolean {
  // Normalize both sides through resolve() so a trailing slash or other
  // non-canonical form of $HOME (getStopBoundary returns homedir() raw)
  // can't make the equality and relative() checks disagree and fail open.
  const home = resolve(getStopBoundary());
  const resolvedDir = resolve(dir);
  if (resolvedDir === home) {
    return true;
  }
  // `dir` is an ancestor of home when the path from dir → home doesn't
  // climb back out (no leading "..") and stays relative.
  const rel = relative(resolvedDir, home);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Process one directory level during the walk-up search
 */
async function processDirectoryLevel(
  currentDir: string,
  languageMarkerAt: string | null,
  buildSystemAt: string | null
): Promise<{
  dsnResult: DetectedDsn | null;
  repoRootResult: { found: boolean; type?: "vcs" | "ci" | "editorconfig" };
  hasLang: boolean;
  hasBuild: boolean;
}> {
  // Run all checks for this level in parallel
  const [dsnResult, repoRootResult, hasLang, hasBuild] = await Promise.all([
    checkEnvForDsn(currentDir),
    hasRepoRootMarker(currentDir),
    languageMarkerAt ? Promise.resolve(false) : hasLanguageMarker(currentDir),
    buildSystemAt ? Promise.resolve(false) : hasBuildSystemMarker(currentDir),
  ]);

  return { dsnResult, repoRootResult, hasLang, hasBuild };
}

/**
 * Determine the final project root from candidates
 */
function selectProjectRoot(
  languageMarkerAt: string | null,
  buildSystemAt: string | null,
  fallback: string
): { projectRoot: string; reason: ProjectRootReason } {
  if (languageMarkerAt) {
    return { projectRoot: languageMarkerAt, reason: "language" };
  }
  if (buildSystemAt) {
    return { projectRoot: buildSystemAt, reason: "build_system" };
  }
  return { projectRoot: fallback, reason: "fallback" };
}

/**
 * Create result when DSN is found in .env file
 */
function createDsnFoundResult(
  currentDir: string,
  dsnResult: DetectedDsn,
  levelsTraversed: number
): ProjectRootResult {
  return {
    projectRoot: currentDir,
    foundDsn: dsnResult,
    reason: "env_dsn",
    levelsTraversed,
  };
}

/**
 * Create result when repo root marker is found.
 * Maps marker type to reason (defaults to "vcs" for undefined).
 *
 * If a language marker was already found closer to cwd, prefer it over the
 * repo root to support monorepos (e.g., user working in packages/frontend
 * should use that as root, not the repo root).
 */
function createRepoRootResult(
  currentDir: string,
  markerType: "vcs" | "ci" | "editorconfig" | undefined,
  levelsTraversed: number,
  languageMarkerAt: string | null
): ProjectRootResult {
  // Prefer closer language marker over repo root for monorepo support
  if (languageMarkerAt) {
    return {
      projectRoot: languageMarkerAt,
      reason: "language",
      levelsTraversed,
    };
  }

  return {
    projectRoot: currentDir,
    reason: markerType ?? "vcs",
    levelsTraversed,
  };
}

/**
 * Finalize accumulated sentryclirc config: apply global fallbacks and cache.
 */
async function finalizeSentryCliRc(
  cwd: string,
  config: SentryCliRcConfig
): Promise<void> {
  await applyGlobalFallbacks(config);
  setSentryCliRcCache(cwd, config);
}

/**
 * Walk up directories searching for project root.
 *
 * Uses the shared {@link walkUpFrom} generator for directory traversal
 * (with symlink cycle detection). Also reads `.sentryclirc` files at each
 * level and populates the sentryclirc cache (with global fallbacks applied),
 * so that a later `loadSentryCliRc` call for the same `cwd` is a cache hit
 * instead of a second walk.
 *
 * Stops at the `stopBoundary` (home dir) after processing it, or when the
 * generator reaches the filesystem root.
 */
async function walkUpDirectories(
  resolvedStart: string,
  stopBoundary: string
): Promise<ProjectRootResult> {
  let levelsTraversed = 0;
  let languageMarkerAt: string | null = null;
  let buildSystemAt: string | null = null;
  const rcConfig = createSentryCliRcConfig();

  for await (const currentDir of walkUpFrom(resolvedStart)) {
    levelsTraversed += 1;

    // Check project-root markers AND .sentryclirc in parallel
    const [{ dsnResult, repoRootResult, hasLang, hasBuild }] =
      await Promise.all([
        processDirectoryLevel(currentDir, languageMarkerAt, buildSystemAt),
        applySentryCliRcDir(rcConfig, currentDir),
      ]);

    // 1. Check for DSN in .env files - immediate return (unless at/above home directory)
    // Don't use a .env in the home directory as a project root indicator,
    // as users may have global configs that shouldn't define project boundaries
    if (dsnResult && currentDir !== stopBoundary) {
      await finalizeSentryCliRc(resolvedStart, rcConfig);
      return createDsnFoundResult(currentDir, dsnResult, levelsTraversed);
    }

    // 2. Check for VCS/CI markers - definitive root, stop walking
    if (repoRootResult.found) {
      await finalizeSentryCliRc(resolvedStart, rcConfig);
      return createRepoRootResult(
        currentDir,
        repoRootResult.type,
        levelsTraversed,
        languageMarkerAt
      );
    }

    // 3. Remember language marker (closest to cwd wins)
    if (!languageMarkerAt && hasLang) {
      languageMarkerAt = currentDir;
    }

    // 4. Remember build system marker (last resort)
    if (!buildSystemAt && hasBuild) {
      buildSystemAt = currentDir;
    }

    // Stop at boundary after processing it (e.g., home dir)
    if (currentDir === stopBoundary) {
      break;
    }
  }

  // Populate sentryclirc cache from accumulated data
  setSentryCliRcCache(resolvedStart, rcConfig);

  // Determine project root from candidates (priority order)
  const selected = selectProjectRoot(
    languageMarkerAt,
    buildSystemAt,
    resolvedStart
  );

  return {
    projectRoot: selected.projectRoot,
    reason: selected.reason,
    levelsTraversed,
  };
}

/**
 * Find project root by walking up from starting directory.
 *
 * Checks for DSN in .env files at each level (early exit if found).
 * Stops at VCS/CI markers (definitive repo root).
 * Falls back to language markers, then build system markers.
 *
 * @param startDir - Directory to start searching from
 * @returns Project root result with optional DSN
 */
export function findProjectRoot(startDir: string): Promise<ProjectRootResult> {
  return withTracingSpan(
    "findProjectRoot",
    "dsn.detect",
    async (span) => {
      const resolvedStart = resolve(startDir);
      const stopBoundary = getStopBoundary();

      const result = await walkUpDirectories(resolvedStart, stopBoundary);

      span.setAttributes({
        "dsn.found": result.foundDsn !== undefined,
        "dsn.reason": result.reason,
        "dsn.levels_traversed": result.levelsTraversed,
        "dsn.project_root": result.projectRoot,
      });

      return result;
    },
    { "dsn.start_dir": startDir }
  );
}
