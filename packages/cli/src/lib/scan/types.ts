/**
 * Public types for the scan module.
 *
 * The walker and ignore stack share a small contract defined here; the
 * types are intentionally narrow for PR 1 (walker-only). PR 2 will add
 * `GrepOptions` / `GrepMatch` / `GrepResult` on top.
 */

/**
 * A single filesystem entry yielded by `walkFiles`. Always a regular file —
 * directories are traversed but never yielded, and symbolic links are
 * skipped unless `followSymlinks: true` is set on the walker.
 *
 * Paths are POSIX-normalized (`/`-separated) on all platforms.
 */
export type WalkEntry = {
  /** Absolute path on disk. Native separators. */
  absolutePath: string;
  /**
   * POSIX-normalized path relative to `WalkOptions.cwd`.
   * Does not start with `./`. Does not end with `/`.
   */
  relativePath: string;
  /** Size in bytes. */
  size: number;
  /**
   * mtime in milliseconds since epoch.
   * Zero when `recordMtimes: false` (the default) — stat'ing every file
   * adds measurable overhead on large scans.
   */
  mtime: number;
  /**
   * True if classified as binary. Classification uses an extension fast
   * path (TEXT_EXTENSIONS members are always text); files with other
   * extensions are tested by reading the first 8 KB and looking for a
   * NUL byte.
   *
   * Known limitation: UTF-16-encoded text is misclassified as binary
   * because its ASCII-range code units produce NUL bytes in the stream.
   */
  isBinary: boolean;
  /**
   * Depth at which this file sits relative to the walk root. Root files
   * are depth 0; `cwd/src/foo.ts` is depth 1. Callers that need
   * monorepo-style depth resets should wrap the walker and track their
   * own counter — the core walker is policy-free.
   */
  depth: number;
};

/**
 * Options controlling `walkFiles`. Only `cwd` is required.
 */
export type WalkOptions = {
  /** Root to walk. Must be an absolute path. */
  cwd: string;

  // --- Filters ---
  /**
   * Extension allowlist. When set, only files whose extension (as
   * returned by `path.extname`, lowercase) is in the set are yielded.
   * Other files are skipped without running the binary sniff, which is
   * both faster and avoids touching binary content.
   *
   * When unset, all files are considered — binary classification still
   * runs, callers just see `isBinary: true` entries they can filter.
   */
  extensions?: ReadonlySet<string>;

  // --- Skip policy ---
  /**
   * Directory basenames to always skip, regardless of `.gitignore`.
   * Defaults to `DEFAULT_SKIP_DIRS` (VCS + common build output dirs).
   * Match semantics are basename-anywhere: any subtree rooted at a
   * directory named `node_modules` is skipped. Spread
   * `DSN_ADDITIONAL_SKIP_DIRS` for stricter DSN-scanner policy.
   */
  alwaysSkipDirs?: readonly string[];
  /**
   * Include dotfiles (files and dirs whose basename starts with `.`).
   * Defaults to `true`, matching `rg --hidden`. `false` skips them —
   * independent of `.gitignore`, so e.g. `.env` is hidden even if the
   * `.gitignore` doesn't mention it.
   */
  hidden?: boolean;
  /** Respect `.gitignore` files found during the walk. Default: true. */
  respectGitignore?: boolean;
  /**
   * Load nested `.gitignore` files as the walker descends. When true,
   * child patterns are applied on top of parent patterns with git-like
   * cumulative semantics. When false, only the root `.gitignore` is
   * read. Default: true.
   */
  nestedGitignore?: boolean;

  // --- Size / depth ---
  /**
   * Skip files larger than this. Defaults to `MAX_FILE_SIZE` (256 KB) —
   * large files rarely contain relevant config/source content.
   */
  maxFileSize?: number;
  /**
   * Exhaustive must-scan depth. The walker visits every directory at
   * depth ≤ `minDepth` regardless of wall-clock. Default: 0 — no
   * minimum guaranteed depth; `timeBudgetMs` alone controls the walk.
   * DSN callers pass `3`.
   */
  minDepth?: number;
  /**
   * Hard depth cap. Files at depth > `maxDepth` are never yielded.
   * Default: Infinity.
   */
  maxDepth?: number;
  /**
   * Compute the depth of a child directory. The walker calls this
   * when descending into `relPath`, passing the parent's current
   * depth. Default: `(_, depth) => depth + 1` (linear descent).
   *
   * Callers that want monorepo-boundary depth resets (e.g., the DSN
   * scanner, which treats `packages/foo/` as its own depth=0 root)
   * override with a closure that returns 0 on package-dir matches.
   * The hook is consulted once per descent, so it must be cheap.
   */
  descentHook?: (relPath: string, currentDepth: number) => number;

  // --- Symlinks + cancellation ---
  /**
   * Follow symlinks. Defaults to false. When true, the walker resolves
   * each symlink via `stat` and maintains a visited `dev:ino` set to
   * avoid cycles.
   */
  followSymlinks?: boolean;
  /**
   * Abort in-flight walks. When the signal fires, the next `yield`
   * throws a `DOMException` with `name === "AbortError"`. Entries
   * already yielded remain valid.
   */
  signal?: AbortSignal;

  // --- Parallelism ---
  /**
   * Max number of directories to `readdir` in parallel. Default:
   * `bulkConcurrency()` (= `max(2, availableParallelism())`), chosen
   * to overlap async `readdir` I/O across directories — the primary
   * speedup (~25%) for bulk scans like DSN detection or sourcemap
   * discovery.
   *
   * Set to `1` for **early-exit** traversal, which uses a direct
   * `yield` serial path (no producer-consumer channel) and sync
   * `readdirSync` — measurably faster when the consumer `break`s
   * after the first few files (e.g. `scanCodeForFirstDsn`).
   *
   * This only controls directory-level concurrency. File content
   * reads (done by callers like `grepFiles`) have their own
   * concurrency knob.
   */
  concurrency?: number;

  // --- Time budget ---
  /**
   * Wall-clock budget in milliseconds. Every directory at depth
   * ≤ `minDepth` is fully explored regardless of the budget. Beyond
   * `minDepth`, each candidate descent is skipped once
   * `clock() - startedAt > timeBudgetMs`. Already-queued directories
   * still drain (files at their depth get yielded), but no new dirs
   * at `depth > minDepth` are opened. Default: Infinity.
   */
  timeBudgetMs?: number;
  /**
   * Monotonic clock. Defaults to `performance.now`. Tests inject a
   * mock function to deterministically verify time-budget behavior.
   */
  clock?: () => number;

  // --- Output control ---
  /**
   * Populate `mtime` on each yielded entry. When false (the default),
   * `mtime` is always 0 — which is fine for grep/search consumers.
   * DSN-style cache invalidation callers pass `true`.
   */
  recordMtimes?: boolean;
  /**
   * Classify each yielded file as binary, populating `WalkEntry.isBinary`.
   * Default: `true`.
   *
   * When `true` (and no `extensions` allowlist is set), files with an
   * unknown extension are sniffed by reading their first 8 KB and looking
   * for a NUL byte. Consumers that ignore `isBinary` and walk large
   * binary-heavy trees (e.g. the debug-information-file scanner) should
   * pass `false` to skip that per-file head-read entirely — every entry is
   * then reported with `isBinary: false` without touching file contents.
   * Has no effect when `extensions` is set (classification is already
   * skipped for allowlisted files).
   */
  classifyBinary?: boolean;
  /**
   * Observer invoked once per directory the walker enters, with the
   * directory's absolute path and its floored `stat.mtimeMs`. Fires
   * after the directory's entries are read but before any children
   * are yielded.
   *
   * Stat'ing costs one extra `stat()` per directory when set; when
   * unset (the default), the walker does not stat directories at all.
   * Used by the DSN scanner to populate `dirMtimes` for cache
   * invalidation — the walker stays policy-free.
   */
  onDirectoryVisit?: (absDir: string, mtimeMs: number) => void;
};

/**
 * Contract implemented by `IgnoreStack` in `./ignore.js`.
 *
 * Isolated as an interface so the walker can accept alternative matcher
 * implementations (e.g., a pass-through matcher in tests).
 */
export type IgnoreMatcher = {
  /**
   * True if `relativePath` should be ignored.
   *
   * `relativePath` must be POSIX-normalized and relative to the walker's
   * `cwd`. `isDirectory` lets the matcher honor trailing-slash patterns
   * (e.g., `build/` matches only directories).
   */
  isIgnored(relativePath: string, isDirectory: boolean): boolean;
  /**
   * Read the `.gitignore` file inside `absDir`, if any. No-op when the
   * file doesn't exist. Called by the walker on descent when
   * `nestedGitignore: true`.
   */
  loadFromDir(absDir: string): Promise<void>;
};

/**
 * A single hit emitted by `grepFiles`. One `GrepMatch` per matching
 * line — multi-line patterns are not supported in this iteration.
 */
export type GrepMatch = {
  /** POSIX-normalized path relative to `GrepOptions.cwd`. */
  path: string;
  /** Absolute path on disk (for callers that want to re-open). */
  absolutePath: string;
  /** 1-based line number. */
  lineNum: number;
  /**
   * Line content, truncated at `maxLineLength` (default 2000) with a
   * `…` suffix. Trailing `\r` on CRLF files is preserved verbatim —
   * consumers that care should trim their own way.
   */
  line: string;
  /**
   * Floored `stat.mtimeMs` of the source file. Populated only when
   * `GrepOptions.recordMtimes` is true; otherwise omitted (not
   * zero — the absence distinguishes "not asked" from "asked and
   * happens to be 0"). Consumers use this for cache invalidation;
   * see `src/lib/dsn/code-scanner.ts`.
   */
  mtime?: number;
};

/**
 * Options for `grepFiles` / `collectGrep`. Only `cwd` and `pattern`
 * are required. All walker options are forwarded to the underlying
 * `walkFiles` call.
 */
export type GrepOptions = {
  /** Absolute root directory. */
  cwd: string;
  /**
   * Regex source string (compiled by `compilePattern`) or a
   * pre-compiled `RegExp`. Pre-compiled regexes are trusted and used
   * verbatim — callers that want `caseSensitive` etc. should build
   * their own RegExp. String input supports leading inline flags
   * `(?i)` / `(?im)` / `(?i:...)`.
   */
  pattern: string | RegExp;

  // --- Filters layered on top of the walker ---
  /**
   * One or more glob patterns (picomatch syntax). When set, only files
   * whose path (or basename when the pattern has no `/`) matches at
   * least one pattern are scanned.
   */
  include?: string | readonly string[];
  /** One or more glob patterns that suppress matching files. */
  exclude?: string | readonly string[];
  /**
   * Subdirectory under `cwd` to narrow the walk root. Path traversal
   * out of `cwd` is the caller's responsibility (the grep engine
   * trusts this value — use `safePath` at adapter boundaries).
   */
  path?: string;

  // --- WalkOptions pass-through ---
  extensions?: ReadonlySet<string>;
  alwaysSkipDirs?: readonly string[];
  respectGitignore?: boolean;
  nestedGitignore?: boolean;
  hidden?: boolean;
  maxDepth?: number;
  minDepth?: number;
  maxFileSize?: number;
  descentHook?: WalkOptions["descentHook"];
  followSymlinks?: boolean;
  /**
   * When true, each `GrepMatch` includes the source file's floored
   * `mtimeMs`. Used by cache-invalidation layers (e.g., the DSN
   * scanner's `sourceMtimes` map). Forwarded to the walker;
   * incidentally costs an extra stat per file, so it's opt-in.
   */
  recordMtimes?: boolean;
  /**
   * Optional hook invoked once per directory visited during the
   * walk with its floored `mtimeMs`. Used for directory-level cache
   * invalidation (e.g., "has a new file been added to this dir?").
   * Forwarded to `walkFiles`.
   */
  onDirectoryVisit?: WalkOptions["onDirectoryVisit"];

  // --- Grep-specific ---
  /**
   * Case-sensitive match. Default: true (matches rg's default).
   * Leading `(?i)` in the pattern OR `caseSensitive: false` both
   * produce a case-insensitive match.
   */
  caseSensitive?: boolean;
  /**
   * Control the `m` flag on the compiled pattern.
   *
   * - `true` (default): `^` / `$` match at line boundaries inside
   *   each file. This is the grep-like semantic — patterns like
   *   `^foo` match any line that starts with `foo`, not just the
   *   first line of the file. Matches `rg`'s default behavior.
   * - `false`: strict JS semantics — `^` anchors to the buffer start
   *   and `$` to the buffer end. Only useful for patterns that
   *   explicitly want to match on the whole file as a single unit.
   *
   * The default differs from `compilePattern`'s lower-level default
   * (`false`): whole-buffer iteration needs the `m` flag to recover
   * the line-boundary anchoring that a line-by-line engine would
   * get for free.
   */
  multiline?: boolean;
  /**
   * Include files classified as binary by the walker. Default: false,
   * matching `rg`'s default. When `extensions` is passed the walker
   * marks everything `isBinary: false` and this option is a no-op.
   */
  includeBinary?: boolean;
  /** Hard cap on total matches across all files. Default: unlimited. */
  maxResults?: number;
  /** Stop at the first match — used by DSN's scanCodeForFirstDsn. */
  stopOnFirst?: boolean;
  /** Per-file match cap. Default: unlimited. */
  maxMatchesPerFile?: number;
  /** Truncate each match's `line` to this many chars. Default: 2000. */
  maxLineLength?: number;
  /**
   * Parallel file-read + regex work. Default: CONCURRENCY_LIMIT (50).
   * Forwarded to the internal `mapFilesConcurrent` helper.
   */
  concurrency?: number;

  // --- Cancellation / budget ---
  signal?: AbortSignal;
  /** Forwarded to `walkFiles` — time budget on the underlying walk. */
  timeBudgetMs?: number;
};

/** Aggregate stats returned alongside matches from `collectGrep`. */
export type GrepStats = {
  /** Files yielded by the walker (before the grep's own filters). */
  filesConsidered: number;
  /** Files whose content was read and tested against the pattern. */
  filesRead: number;
  /** Files skipped because `isBinary: true` and `includeBinary: false`. */
  filesSkippedBinary: number;
  /** Total matches emitted. Equal to `matches.length` unless truncated. */
  matchesEmitted: number;
  /** True when `maxResults` or `stopOnFirst` cut the walk short. */
  truncated: boolean;
};

/** Return shape of `collectGrep`. */
export type GrepResult = {
  /** Matches in a stable order: sorted by `[path, lineNum]`. */
  matches: GrepMatch[];
  stats: GrepStats;
};

/**
 * Options for `globFiles` / `collectGlob`. Globs are post-filters
 * over the walker's yield; there is no stat cost beyond what the
 * walker already pays.
 */
export type GlobOptions = {
  cwd: string;
  /** One or more glob patterns (picomatch syntax). OR semantics. */
  patterns: string | readonly string[];
  /** Negative patterns. A file matching any `exclude` is suppressed. */
  exclude?: string | readonly string[];
  /** Subdirectory under `cwd` to narrow the walk root. */
  path?: string;

  // --- WalkOptions pass-through ---
  alwaysSkipDirs?: readonly string[];
  respectGitignore?: boolean;
  nestedGitignore?: boolean;
  hidden?: boolean;
  maxDepth?: number;
  minDepth?: number;
  descentHook?: WalkOptions["descentHook"];
  followSymlinks?: boolean;

  // --- Glob-specific ---
  /** Cap on emitted paths. Default: unlimited. */
  maxResults?: number;
  signal?: AbortSignal;
  timeBudgetMs?: number;
};

/** Return shape of `collectGlob`. */
export type GlobResult = {
  /** Matching paths, POSIX-normalized + relative to cwd, sorted. */
  files: string[];
  /** True when `maxResults` was hit mid-walk. */
  truncated: boolean;
};
