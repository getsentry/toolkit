/**
 * Centralized git helpers
 *
 * Low-level git primitives used across the CLI: release management,
 * init wizard pre-flight checks, and version detection.
 *
 * Uses `execFileSync` (no shell) from `node:child_process` instead of
 * `Bun.spawnSync` because this module is also used by the npm/Node
 * distribution (via esbuild bundle), where Bun APIs are shimmed but
 * `node:child_process` works natively. This avoids shell injection
 * risks and is consistent with the AGENTS.md `execSync` exception.
 */

import { execFileSync } from "node:child_process";

import { ValidationError, validationError } from "./errors.js";

/** `execFileSync` failure shape when git exits non-zero. */
type ExecFileSyncError = Error & {
  stderr?: string | Buffer;
  stdout?: string | Buffer;
};

/**
 * Return true when git stderr indicates an unknown or invalid revision ref.
 *
 * Used to surface friendly {@link ValidationError}s instead of raw git output.
 */
function isUnknownGitRefError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("stderr" in error)) {
    return false;
  }
  const stderr = String((error as ExecFileSyncError).stderr ?? "");
  return (
    stderr.includes("unknown revision") ||
    stderr.includes("bad revision") ||
    stderr.includes("ambiguous argument") ||
    stderr.includes("Invalid revision range")
  );
}

/** Commit data structure matching the Sentry releases API */
export type GitCommit = {
  id: string;
  message: string;
  author_name: string;
  author_email: string;
  timestamp: string;
  repository?: string;
};

/**
 * Upper bound on captured git stdout (100 MB).
 *
 * `execFileSync` defaults to a 1 MB `maxBuffer` and throws
 * `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` once exceeded. Uncapped `git log`
 * (e.g. `getCommitLog` with `--from` and no `--max-count`) can emit far more
 * than 1 MB on a large `from..HEAD` range, so raise the limit to avoid
 * crashing on big histories. ~200 bytes/commit → this allows ~500k commits.
 */
const GIT_MAX_BUFFER = 100 * 1024 * 1024;

/**
 * Run a git command and return trimmed stdout.
 *
 * Uses `execFileSync` (no shell) to avoid shell injection risks.
 * Arguments are passed as an array, not interpolated into a string.
 *
 * @param args - Git subcommand and arguments as separate strings
 * @param cwd - Working directory
 * @returns Trimmed stdout
 * @throws On non-zero exit
 */
function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
  }).trim();
}

// ---------------------------------------------------------------------------
// Repository status
// ---------------------------------------------------------------------------

/**
 * Check if the current directory is inside a git work tree.
 *
 * @param cwd - Working directory
 * @returns true if inside a git work tree
 */
export function isInsideGitWorkTree(cwd?: string): boolean {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the list of uncommitted or untracked files.
 *
 * Returns each line from `git status --porcelain=v1` prefixed with `- `.
 * Empty array if the working tree is clean or not a git repo.
 *
 * @param cwd - Working directory
 * @returns Array of formatted status lines (e.g., `["- M src/index.ts", "- ?? new-file.ts"]`)
 */
export function getUncommittedFiles(cwd?: string): string[] {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const raw = git(["status", "--porcelain=v1"], cwd);
    if (!raw) {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => `- ${line}`);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Commit info
// ---------------------------------------------------------------------------

/**
 * Get the HEAD commit SHA.
 *
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns 40-char commit SHA
 * @throws {ValidationError} When not inside a git repository
 */
export function getHeadCommit(cwd?: string): string {
  try {
    return git(["rev-parse", "HEAD"], cwd);
  } catch {
    throw new ValidationError(
      "Not a git repository. Run this command from within a git working tree.",
      "git"
    );
  }
}

/**
 * Check if the current repository is a shallow clone.
 *
 * @param cwd - Working directory
 * @returns true if the repository is shallow
 */
export function isShallowRepository(cwd?: string): boolean {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return git(["rev-parse", "--is-shallow-repository"], cwd) === "true";
  } catch {
    return false;
  }
}

/** NUL byte used as record separator in git log output */
const NUL = "\x00";

/**
 * Get the commit log from HEAD, optionally limited by depth or a starting commit.
 *
 * Uses NUL-delimited output for robust parsing (commit messages can contain newlines).
 * The format string uses git's `%x00` hex escape (not literal NUL bytes) because
 * `execSync` rejects command strings containing null bytes.
 *
 * @param cwd - Working directory
 * @param options - Log options
 * @param options.from - Only include commits after this ref (uses `from..HEAD`)
 * @param options.depth - Maximum number of commits to return (default 20). Pass
 *   a non-positive value together with `from` to read the whole `from..HEAD`
 *   range without a cap. A non-positive depth without `from` still passes
 *   `--max-count` (e.g. `--initial-depth 0` yields zero commits, not all of HEAD).
 * @param options.paths - Restrict the log to commits touching these pathspecs
 *   (appended after `--`). Use for monorepos to scope a release to one subtree.
 *   With `--max-count`, the depth bounds commits *matching* the paths.
 * @returns Array of commit data matching the Sentry releases API format
 */
export function getCommitLog(
  cwd?: string,
  options: { from?: string; depth?: number; paths?: string[] } = {}
): GitCommit[] {
  const { from, depth = 20, paths } = options;

  // Reject option-like refs so a `from` such as "--format=x" can't be parsed
  // as a git option (arg injection). Git refs cannot start with "-" anyway.
  // This is version-independent, unlike `--end-of-options` (git >= 2.24).
  // Mirrors the guard in getMergeBase.
  if (from?.startsWith("-")) {
    throw validationError(
      `--from must be a git ref, not a CLI flag (received '${from}').`,
      ["sentry release set-commits 1.0.0 --from v0.9.0"],
      "from",
      "Git refs cannot start with '-'. Tokens like '--format=x' are CLI flags, not refs — use a tag or commit (e.g. v0.9.0)."
    );
  }

  // Format: hash, subject, author name, author email, author date (ISO)
  // %x00 is git's hex escape for NUL — avoids literal NUL in the command string
  const format = "%H%x00%s%x00%aN%x00%aE%x00%aI";
  const range = from ? `${from}..HEAD` : "HEAD";
  // Drop max-count only for an explicit uncapped range read (`from` + depth <= 0).
  // A non-positive depth without `from` (e.g. `--initial-depth 0`) must still
  // pass --max-count so we don't walk all of HEAD.
  let maxCount: string[];
  if (depth > 0) {
    maxCount = [`--max-count=${depth}`];
  } else if (from) {
    maxCount = [];
  } else {
    maxCount = [`--max-count=${depth}`];
  }
  // Pathspecs go after `--`; each path is a discrete argv entry (no shell), so
  // there is no escaping/injection concern.
  const pathspec = paths && paths.length > 0 ? ["--", ...paths] : [];
  let raw: string;
  try {
    raw = git(
      ["log", `--format=${format}`, ...maxCount, range, ...pathspec],
      cwd
    );
  } catch (error) {
    if (from && isUnknownGitRefError(error)) {
      throw validationError(
        `Unknown git ref '${from}': not found in this repository.`,
        [
          `git rev-parse ${from}`,
          "sentry release set-commits <org>/<version> --from v0.9.0",
        ],
        "from",
        "Range is always <ref>..HEAD — checkout the current release tag first."
      );
    }
    throw error;
  }

  if (!raw) {
    return [];
  }

  return raw.split("\n").map((line) => {
    const [id, message, authorName, authorEmail, timestamp] = line.split(NUL);
    return {
      id: id ?? "",
      message: message ?? "",
      author_name: authorName ?? "",
      author_email: authorEmail ?? "",
      timestamp: timestamp ?? "",
    };
  });
}

/**
 * Get the repository name from the "origin" remote URL.
 *
 * Parses both HTTPS and SSH remote formats:
 * - `https://github.com/owner/repo.git` → `owner/repo`
 * - `git@github.com:owner/repo.git` → `owner/repo`
 *
 * @param cwd - Working directory
 * @returns `owner/repo` string, or undefined if no origin remote
 */
export function getRepositoryName(cwd?: string): string | undefined {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const url = git(["remote", "get-url", "origin"], cwd);
    return parseRemoteUrl(url);
  } catch {
    return;
  }
}

/**
 * Get the raw URL of the "origin" remote.
 *
 * @param cwd - Working directory
 * @returns The remote URL, or undefined when there is no origin remote
 */
export function getRemoteUrl(cwd?: string): string | undefined {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return git(["remote", "get-url", "origin"], cwd);
  } catch {
    return;
  }
}

/**
 * Get the current branch name.
 *
 * @param cwd - Working directory
 * @returns The branch name, or undefined when detached (HEAD) or not a repo
 */
export function getCurrentBranch(cwd?: string): string | undefined {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const ref = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    return ref && ref !== "HEAD" ? ref : undefined;
  } catch {
    return;
  }
}

/**
 * Compute the merge-base SHA of HEAD and the given ref.
 *
 * @param ref - The ref to find the common ancestor with (e.g. a base branch)
 * @param cwd - Working directory
 * @returns The merge-base commit SHA, or undefined when it can't be determined
 *   (unknown ref, shallow clone, not a repo).
 */
export function getMergeBase(ref: string, cwd?: string): string | undefined {
  // Reject option-like refs (a leading "-" would be parsed by git as a flag).
  if (ref.startsWith("-")) {
    return;
  }
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return git(["merge-base", "HEAD", ref], cwd) || undefined;
  } catch {
    return;
  }
}

/**
 * Get the short name of the "origin" remote's default branch.
 *
 * Reads `refs/remotes/origin/HEAD` (populated by `git clone`/`git remote set-head`).
 *
 * @param cwd - Working directory
 * @returns The default branch name (e.g. "main"), or undefined when unknown
 *   (not set, shallow clone, or not a repo).
 */
export function getRemoteDefaultBranch(cwd?: string): string | undefined {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const ref = git(["symbolic-ref", "refs/remotes/origin/HEAD"], cwd);
    const prefix = "refs/remotes/origin/";
    return ref.startsWith(prefix)
      ? ref.slice(prefix.length) || undefined
      : undefined;
  } catch {
    return;
  }
}

/** SSH remote URL pattern: git@host:owner/repo.git */
const SSH_REMOTE_RE = /:([^/][^:]+?)(?:\.git)?$/;

/** Leading slash in URL pathname */
const LEADING_SLASH_RE = /^\//;

/** Trailing .git suffix */
const DOT_GIT_SUFFIX_RE = /\.git$/;

/**
 * Parse a git remote URL to extract `owner/repo`.
 *
 * Handles HTTPS, SSH, and git:// protocols. Strips `.git` suffix.
 *
 * @param url - Remote URL string
 * @returns `owner/repo` string, or undefined if unparseable
 */
export function parseRemoteUrl(url: string): string | undefined {
  // Try URL parsing first — handles https://, ssh://, git:// protocols
  // (including ssh://git@host:port/path which would confuse the SCP regex)
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const parsed = new URL(url);
    const path = parsed.pathname
      .replace(LEADING_SLASH_RE, "")
      .replace(DOT_GIT_SUFFIX_RE, "");
    if (path.includes("/")) {
      return path;
    }
  } catch {
    // Not a valid URL — try SCP-style format below
  }

  // SCP-style SSH format: git@github.com:owner/repo.git
  // Only matched when URL parsing fails (avoids confusion with port numbers)
  const sshMatch = url.match(SSH_REMOTE_RE);
  if (sshMatch && url.includes("@")) {
    return sshMatch[1];
  }

  return;
}

/**
 * Infer the repository name from local git remotes.
 *
 * Tries remotes in priority order: upstream → origin. Falls back to the
 * next remote if the URL can't be parsed.
 *
 * @param cwd - Working directory
 * @returns The repo name and which remote it came from, or undefined
 */
export function inferRepositoryName(
  cwd?: string
): { name: string; remote: string } | undefined {
  for (const remote of ["upstream", "origin"]) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      const url = git(["remote", "get-url", remote], cwd);
      const name = parseRemoteUrl(url);
      if (name) {
        return { name, remote };
      }
    } catch {
      // Remote doesn't exist, try next
    }
  }
  return;
}

/**
 * Infer the default branch from a git remote's HEAD ref.
 *
 * @param remote - The remote name (e.g., "origin", "upstream")
 * @param cwd - Working directory
 * @returns The branch name, or "main" as fallback
 */
export function inferDefaultBranch(remote: string, cwd?: string): string {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const output = git(["symbolic-ref", `refs/remotes/${remote}/HEAD`], cwd);
    // refs/remotes/origin/main → main
    // refs/remotes/origin/release/2.0 → release/2.0
    const prefix = `refs/remotes/${remote}/`;
    return output.startsWith(prefix)
      ? output.slice(prefix.length) || "main"
      : "main";
  } catch {
    return "main";
  }
}
