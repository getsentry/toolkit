/**
 * IgnoreStack — per-directory `.gitignore` aggregation for the scanner.
 *
 * ### Why a stack of instances
 *
 * The `ignore` npm package implements one `.gitignore`-file's semantics
 * (last-matching rule wins inside that file, negations with `!`, etc.).
 * It does NOT know about nested `.gitignore` files.
 *
 * Real git treats nested `.gitignore` files cumulatively: parent rules
 * apply inside every subtree, and child `.gitignore` files can add new
 * rules that apply only in their subtree (including negations that
 * un-ignore something a parent had ignored). See `gitignore(5)`.
 *
 * To match that semantics we keep a `Map<relDir, Ignore>` of per-dir
 * `.gitignore` contents. `isIgnored(relPath)` iterates the ancestor
 * dirs root-first, asks each `Ignore` whether it ignores the file with
 * the path re-anchored to that dir. Because we consult parents first
 * and children last, a child file's `!negation` patterns naturally
 * override parent matches (the child's answer is the last one we see).
 *
 * ### Fast path for root-only stacks
 *
 * Most of the time, `nestedGitignore: true` callers don't actually
 * encounter any nested `.gitignore` files — the root `.gitignore` is
 * the only one loaded. `isIgnored` detects this via a fast-path check
 * (`#nestedByRelDir.size === 0`) and forwards directly to the root
 * `Ignore` instance, skipping all the path-splitting + ancestor-walking
 * machinery. This keeps per-query cost near the underlying library's
 * floor (~0.25µs) when the expensive nested path isn't needed.
 *
 * ### Built-in skip list
 *
 * `alwaysSkipDirs` is a list of directory basenames (e.g., `node_modules`,
 * `.git`) that must be skipped even when no `.gitignore` mentions them.
 * These are seeded as patterns in the root `Ignore` instance.
 *
 * ### `.git/info/exclude`
 *
 * When `includeGitInfoExclude: true`, the root instance also reads
 * `${cwd}/.git/info/exclude` if it exists. Matches ripgrep's behavior.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { handleFileError } from "../dsn/fs-utils.js";
import type { IgnoreMatcher } from "./types.js";

/** Options for constructing an `IgnoreStack`. */
export type IgnoreStackOptions = {
  /** Walker `cwd`. Absolute path. */
  cwd: string;
  /**
   * Directory basenames that must always be skipped. Seeded into the
   * root instance as bare gitignore patterns (basename-anywhere match).
   */
  alwaysSkipDirs: readonly string[];
  /**
   * When false, `.gitignore` / `.git/info/exclude` files are NOT read.
   * Only `alwaysSkipDirs` patterns apply. Default: true.
   */
  respectGitignore?: boolean;
  /**
   * When true (and `respectGitignore` is also true), the root instance
   * is seeded with the contents of `${cwd}/.git/info/exclude` in
   * addition to the root `.gitignore`.
   */
  includeGitInfoExclude?: boolean;
};

/**
 * Per-directory `.gitignore` aggregator.
 *
 * Construct with `await IgnoreStack.create(opts)` — initialization is
 * async because it reads the root `.gitignore` (and optionally
 * `.git/info/exclude`) up front.
 */
export class IgnoreStack implements IgnoreMatcher {
  /** Walker root — absolute. Used to translate absolute dir paths to relative keys. */
  readonly #cwd: string;
  /** Length of `cwd + "/"`. Cached for slicing. */
  readonly #cwdPrefixLen: number;
  /**
   * Root-level matcher. Holds `alwaysSkipDirs` patterns + root
   * `.gitignore` + `.git/info/exclude`. Always present.
   */
  readonly #rootIg: Ignore;
  /**
   * Nested `.gitignore` instances keyed by POSIX-relative dir path
   * (e.g., `"packages/foo"`, `"src/deep"`). Empty when no nested
   * gitignores are loaded — that's the fast-path case.
   *
   * Keys never include a leading or trailing `/`. The root is NOT in
   * this map — it lives in `#rootIg`.
   */
  readonly #nestedByRelDir = new Map<string, Ignore>();
  /** When false, `loadFromDir` is a no-op. */
  readonly #respectGitignore: boolean;

  private constructor(cwd: string, respectGitignore: boolean, rootIg: Ignore) {
    this.#cwd = cwd;
    this.#cwdPrefixLen = cwd.length + 1;
    this.#respectGitignore = respectGitignore;
    this.#rootIg = rootIg;
  }

  /** Build an IgnoreStack and load its root-level patterns. */
  static async create(opts: IgnoreStackOptions): Promise<IgnoreStack> {
    const respectGitignore = opts.respectGitignore ?? true;
    const root = ignore();
    // Seed always-skip directory names as basename-matching patterns.
    // The `ignore` package treats a bare name as basename-anywhere —
    // perfect for skipping any `node_modules` subtree in the walk.
    // These apply even when `respectGitignore: false` because they're
    // the walker's policy, not part of the user's gitignore.
    if (opts.alwaysSkipDirs.length > 0) {
      root.add([...opts.alwaysSkipDirs]);
    }
    if (respectGitignore) {
      await appendGitignoreFile(root, path.join(opts.cwd, ".gitignore"));
      if (opts.includeGitInfoExclude) {
        await appendGitignoreFile(
          root,
          path.join(opts.cwd, ".git", "info", "exclude")
        );
      }
    }
    return new IgnoreStack(opts.cwd, respectGitignore, root);
  }

  /**
   * Read `${absDir}/.gitignore` into a new `Ignore` instance scoped to
   * that dir. No-op if the file is missing or empty, or when
   * `respectGitignore: false` was set on construction.
   *
   * Callers (the walker) invoke this on directory descent when
   * `nestedGitignore: true`. Idempotent: calling twice with the same
   * path replaces the earlier instance.
   */
  async loadFromDir(absDir: string): Promise<void> {
    if (!this.#respectGitignore) {
      return;
    }
    // Never re-seed the root — that was populated by `create()`.
    if (absDir === this.#cwd) {
      return;
    }
    const gitignorePath = path.join(absDir, ".gitignore");
    try {
      const content = await readFile(gitignorePath, "utf-8");
      if (!content || content.trim().length === 0) {
        return;
      }
      const ig = ignore();
      ig.add(content);
      const relDir = this.#relDirFor(absDir);
      if (relDir === null) {
        // Absolute dir isn't under cwd — refuse to register it.
        return;
      }
      this.#nestedByRelDir.set(relDir, ig);
    } catch (error) {
      // ENOENT is the expected case — most directories don't have a
      // `.gitignore`. Anything else (permission, I/O) goes through
      // `handleFileError` so genuine bugs still surface to Sentry.
      handleFileError(error, {
        operation: "scan.ignore.loadFromDir",
        path: gitignorePath,
      });
    }
  }

  /**
   * Fast-path-aware `isIgnored`.
   *
   * When no nested gitignores are loaded (the common case), query
   * `#rootIg` directly — bypasses all ancestor-walking and path
   * splicing, bringing per-query cost to the underlying `ignore`
   * package's floor.
   *
   * Otherwise: walk the ancestor prefix chain root→leaf, applying each
   * loaded `Ignore` in turn. Inside each instance, `ignore`'s
   * last-match-wins semantics handle intra-file negations; across
   * instances, a child `!foo` pattern flips an earlier `ignored=true`
   * back to `false` because we see later results last.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: two-tier fast+slow path with negation handling is inherently branchy
  isIgnored(relPath: string, isDirectory: boolean): boolean {
    if (path.isAbsolute(relPath)) {
      // Programming error — a misuse that would silently produce wrong
      // results inside `ignore`. Throwing here flags it immediately.
      throw new Error(
        `IgnoreStack.isIgnored requires a relative path, got: ${relPath}`
      );
    }
    if (relPath === "" || relPath === ".") {
      return false;
    }

    const trailingSlash = isDirectory ? "/" : "";
    const query = `${relPath}${trailingSlash}`;

    // --- Tier 1: root-only fast path (most common) ---
    if (this.#nestedByRelDir.size === 0) {
      return this.#rootIg.ignores(query);
    }

    // --- Tier 2: walk loaded ancestor prefixes root→leaf ---
    //
    // Start with the root's verdict. Then, for each prefix of `relPath`
    // that is a loaded nested dir, re-query with the path reanchored
    // to that dir. A match flips `ignored`; an `unignored` (negation)
    // result flips it back to false.
    const rootResult = this.#rootIg.test(query);
    let ignored = rootResult.ignored && !rootResult.unignored;
    if (rootResult.unignored) {
      ignored = false;
    }

    // Walk `a/b/c/file.ts` → prefixes "a", "a/b", "a/b/c".
    // We skip the final segment (the file itself — a file can't own
    // a `.gitignore`).
    let prefixEnd = relPath.indexOf("/");
    while (prefixEnd !== -1) {
      const prefix = relPath.slice(0, prefixEnd);
      const ig = this.#nestedByRelDir.get(prefix);
      if (ig !== undefined) {
        // Rebase the query under this dir: path inside the nested scope
        // is the suffix past `prefix/`.
        const suffix = `${relPath.slice(prefixEnd + 1)}${trailingSlash}`;
        if (suffix.length > 0) {
          const result = ig.test(suffix);
          if (result.unignored) {
            ignored = false;
          } else if (result.ignored) {
            ignored = true;
          }
        }
      }
      prefixEnd = relPath.indexOf("/", prefixEnd + 1);
    }
    return ignored;
  }

  /**
   * Convert an absolute directory path to its POSIX-relative form
   * under `cwd`. Returns null when `absDir` isn't a descendant of cwd.
   */
  #relDirFor(absDir: string): string | null {
    if (!absDir.startsWith(this.#cwd)) {
      return null;
    }
    if (absDir.length === this.#cwd.length) {
      return "";
    }
    if (absDir[this.#cwd.length] !== path.sep) {
      return null;
    }
    const tail = absDir.slice(this.#cwdPrefixLen);
    return path.sep === path.posix.sep ? tail : tail.replaceAll(path.sep, "/");
  }
}

/**
 * Load the contents of a gitignore-like file into an existing `Ignore`
 * instance. Swallows ENOENT (the common case); routes other errors to
 * `handleFileError` so genuine bugs surface to Sentry.
 */
async function appendGitignoreFile(ig: Ignore, absPath: string): Promise<void> {
  try {
    const content = await readFile(absPath, "utf-8");
    if (content.length > 0) {
      ig.add(content);
    }
  } catch (error) {
    handleFileError(error, {
      operation: "scan.ignore.appendGitignoreFile",
      path: absPath,
    });
  }
}
