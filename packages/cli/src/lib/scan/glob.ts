/**
 * Pure-TS glob engine built on top of `walkFiles`.
 *
 * Accepts one or more glob patterns (picomatch syntax) and yields
 * files under `cwd` matching at least one `patterns` entry and no
 * `exclude` entry. Matching uses the `picomatch` package.
 *
 * ### Pattern semantics
 *
 * - Patterns with a `/` are matched against the POSIX-normalized
 *   relative path (e.g., `src/*.ts` only matches files directly in
 *   `src/`).
 * - Patterns without a `/` are matched against just the basename
 *   (e.g., `*.ts` matches `any/dir/x.ts`).
 * - `dot: true` — the matcher accepts dotfiles, matching the
 *   walker's default `hidden: true`.
 * - `**` spans directory boundaries.
 *
 * Uses picomatch's full grammar: extglobs (`+(a|b)`), braces
 * (`{a,b}`), negation (`!pattern`), etc.
 *
 * ### Cost model
 *
 * Globs layer onto the walker's output; no new stat calls are made.
 * Compiled matchers are cached per call (single picomatch compile
 * per `patterns`/`exclude` entry) so walking 10k files costs ~2
 * compile calls + 10k `(rel|basename) → bool` invocations.
 */

import {
  basenameOf,
  compileMatchers,
  joinPosix,
  matchesAny,
  walkerRoot,
} from "./path-utils.js";
import type { GlobOptions, GlobResult, WalkOptions } from "./types.js";
import { walkFiles } from "./walker.js";

/**
 * Yield relative paths under `opts.cwd` that match at least one of
 * `opts.patterns` and none of `opts.exclude`.
 *
 * Emits in walker order (lexicographic per-directory; see
 * `walker.ts::compareByName`).
 *
 * The `opts.patterns` field is required — a glob with no patterns
 * returns immediately.
 */
export async function* globFiles(opts: GlobOptions): AsyncGenerator<string> {
  const includes = compileMatchers(opts.patterns);
  if (includes.length === 0) {
    return;
  }
  const excludes = compileMatchers(opts.exclude);

  const root = walkerRoot(opts.cwd, opts.path);
  const walkOpts: WalkOptions = {
    cwd: root,
    alwaysSkipDirs: opts.alwaysSkipDirs,
    respectGitignore: opts.respectGitignore,
    nestedGitignore: opts.nestedGitignore,
    hidden: opts.hidden,
    maxDepth: opts.maxDepth,
    minDepth: opts.minDepth,
    descentHook: opts.descentHook,
    followSymlinks: opts.followSymlinks,
    signal: opts.signal,
    timeBudgetMs: opts.timeBudgetMs,
  };

  const maxResults = opts.maxResults ?? Number.POSITIVE_INFINITY;
  let emitted = 0;

  for await (const entry of walkFiles(walkOpts)) {
    // entry.relativePath is relative to the walker's root, which is
    // `opts.path`-anchored. Convert to a cwd-relative path so the
    // public output is always relative to the caller's cwd.
    const relToRoot = entry.relativePath;
    const basename = basenameOf(relToRoot);
    if (!matchesAny(includes, relToRoot, basename)) {
      continue;
    }
    if (excludes.length > 0 && matchesAny(excludes, relToRoot, basename)) {
      continue;
    }

    const relToCwd = opts.path ? joinPosix(opts.path, relToRoot) : relToRoot;
    yield relToCwd;
    emitted += 1;
    if (emitted >= maxResults) {
      return;
    }
  }
}

/**
 * Drain `globFiles` into a sorted array and report whether the walk
 * was truncated by `maxResults`.
 *
 * Sort key: byte-lexicographic on the relative path. This matches
 * `Array.prototype.sort`'s default and is stable across runs.
 *
 * We forward `maxResults + 1` to the iterator so we can distinguish
 * "exactly N matches" from "more than N matches were available".
 */
export async function collectGlob(opts: GlobOptions): Promise<GlobResult> {
  const maxResults = opts.maxResults ?? Number.POSITIVE_INFINITY;
  const probeLimit = Number.isFinite(maxResults)
    ? Math.min(Number.MAX_SAFE_INTEGER, maxResults + 1)
    : Number.POSITIVE_INFINITY;

  const files: string[] = [];
  let truncated = false;
  for await (const file of globFiles({ ...opts, maxResults: probeLimit })) {
    if (files.length >= maxResults) {
      truncated = true;
      break;
    }
    files.push(file);
  }
  files.sort();
  return { files, truncated };
}
