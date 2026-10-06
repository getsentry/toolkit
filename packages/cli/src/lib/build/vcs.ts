/**
 * VCS (git) metadata collection for `build upload` (and, later, `snapshots`).
 *
 * Mirrors the legacy `collect_git_metadata`: explicit flags always win; when
 * auto-collection is enabled (CI, unless `--no-git-metadata`), values are
 * inferred from GitHub Actions env vars and the local git repository.
 *
 * The collected {@link VcsInfo} is flattened (via {@link vcsInfoToBody}) into
 * the build assemble request as top-level `head_sha`, `base_sha`, `provider`,
 * `head_repo_name`, `base_repo_name`, `head_ref`, `base_ref`, `pr_number`
 * (empty values omitted), matching the server's flattened `VcsInfo` shape.
 */

import { readFileSync } from "node:fs";
import { ValidationError } from "../errors.js";
import {
  getCurrentBranch,
  getHeadCommit,
  getMergeBase,
  getRemoteDefaultBranch,
  getRemoteUrl,
  getRepositoryName,
} from "../git.js";
import { logger } from "../logger.js";

const log = logger.withTag("build.vcs");

/** Structured VCS metadata for a build upload. */
export type VcsInfo = {
  /** HEAD commit SHA. */
  headSha?: string;
  /** Base commit SHA (merge-base with the target branch). */
  baseSha?: string;
  /** VCS provider name (e.g. `github`, `gitlab`). */
  vcsProvider?: string;
  /** Head repository name (`owner/repo`). */
  headRepoName?: string;
  /** Base repository name (`owner/repo`), for forks. */
  baseRepoName?: string;
  /** Head branch/reference. */
  headRef?: string;
  /** Base branch/reference. */
  baseRef?: string;
  /** Pull request number. */
  prNumber?: number;
};

/** Git-metadata flags accepted by build/snapshot upload commands. */
export type VcsFlags = {
  "head-sha"?: string;
  "base-sha"?: string;
  "vcs-provider"?: string;
  "head-repo-name"?: string;
  "base-repo-name"?: string;
  "head-ref"?: string;
  "base-ref"?: string;
  "pr-number"?: number;
  "force-git-metadata"?: boolean;
  "no-git-metadata"?: boolean;
};

/** Environment variables commonly set by CI providers. */
const CI_ENV_VARS = [
  "CI",
  "JENKINS_URL",
  "HUDSON_URL",
  "TEAMCITY_VERSION",
  "CIRCLE_BUILD_URL",
  "bamboo_resultsUrl",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "TRAVIS_JOB_ID",
  "BITRISE_BUILD_URL",
  "GO_SERVER_URL",
  "TF_BUILD",
  "BUILDKITE",
];

/**
 * Detect whether we are running in a CI environment.
 *
 * @param env - Environment variables (defaults to `process.env`).
 */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return CI_ENV_VARS.some((name) => {
    const value = env[name];
    // Treat explicit opt-out values ("", "false", "0") as not-in-CI so a local
    // `CI=false` does not silently enable git-metadata collection.
    return (
      value !== undefined &&
      value !== "" &&
      value !== "false" &&
      value !== "0"
    );
  });
}

/** A 40-character lowercase hex SHA-1. */
const SHA1_RE = /^[0-9a-f]{40}$/;

/**
 * Normalize an already-trusted SHA (from git/event payload): lowercase and
 * accept only a valid 40-char hex SHA-1, else undefined.
 */
function normalizeSha(sha: string | undefined): string | undefined {
  const trimmed = sha?.trim().toLowerCase();
  return trimmed && SHA1_RE.test(trimmed) ? trimmed : undefined;
}

/**
 * Validate a user-supplied `--head-sha`/`--base-sha` value. An empty string is
 * an explicit "clear" (returns undefined, suppressing auto-inference at the
 * call site); a non-empty value must be a 40-char hex SHA-1.
 *
 * @throws {ValidationError} When a non-empty value is not a valid SHA-1.
 */
function validateShaFlag(value: string, flagName: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (!SHA1_RE.test(trimmed)) {
    throw new ValidationError(
      `Invalid --${flagName}: expected a 40-character hex SHA-1`,
      flagName
    );
  }
  return trimmed;
}

/**
 * Read the PR head/base SHA from the GitHub Actions event payload.
 *
 * On `pull_request` runs `actions/checkout` checks out the ephemeral merge
 * commit, so `git rev-parse HEAD` is NOT the PR head — the event payload's
 * `pull_request.{head,base}.sha` is authoritative (matches the legacy CLI).
 */
function readGithubEventSha(
  kind: "head" | "base",
  env: NodeJS.ProcessEnv
): string | undefined {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return undefined;
  }
  try {
    const payload = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: { head?: { sha?: unknown }; base?: { sha?: unknown } };
    };
    const sha = payload.pull_request?.[kind]?.sha;
    return typeof sha === "string" ? normalizeSha(sha) : undefined;
  } catch (err) {
    log.debug(`Could not read ${kind} SHA from GITHUB_EVENT_PATH`, err);
    return undefined;
  }
}

/** Extract a provider name (e.g. `github`) from a git remote URL's host. */
function providerFromRemoteUrl(url: string): string | undefined {
  let host: string | undefined;
  try {
    host = new URL(url).hostname;
  } catch {
    // SCP-style (git@host:owner/repo) — pull the host between "@" and ":".
    host = url.match(/@([^:/]+)[:/]/)?.[1];
  }
  if (!host) {
    return undefined;
  }
  host = host.replace(/\.$/, "").toLowerCase();
  if (host.endsWith(".ghe.com")) {
    return "github_enterprise";
  }
  // Best effort for the general case: drop the TLD (github.com → github);
  // self-hosted hosts yield their second-level label (e.g. git.acme.com → acme).
  const labels = host.split(".");
  return labels.length >= 2 ? labels.at(-2) : host;
}

/** GitHub Actions head ref: PR source branch, else the pushed branch/tag name. */
function githubHeadRef(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GITHUB_EVENT_NAME === "pull_request") {
    return env.GITHUB_HEAD_REF || undefined;
  }
  return env.GITHUB_REF_NAME || undefined;
}

/** GitHub Actions base ref: PR target branch (pull_request events only). */
function githubBaseRef(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    return undefined;
  }
  return env.GITHUB_BASE_REF || undefined;
}

/** GitHub Actions PR number, parsed from GITHUB_REF (`refs/pull/N/merge`). */
function githubPrNumber(env: NodeJS.ProcessEnv): number | undefined {
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    return undefined;
  }
  const raw = env.GITHUB_REF?.match(/^refs\/pull\/(\d+)\//)?.[1];
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Read git HEAD, swallowing "not a repo" into undefined. */
function tryGitHeadSha(cwd: string): string | undefined {
  try {
    return normalizeSha(getHeadCommit(cwd));
  } catch (err) {
    log.debug("Could not determine HEAD commit", err);
    return undefined;
  }
}

/**
 * Resolve the head SHA: explicit flag (present, even if empty) → GitHub event
 * payload → git HEAD. A present-but-empty flag suppresses auto-inference.
 */
function resolveHeadSha(
  flags: VcsFlags,
  cwd: string,
  env: NodeJS.ProcessEnv,
  auto: boolean
): string | undefined {
  if (flags["head-sha"] !== undefined) {
    return validateShaFlag(flags["head-sha"], "head-sha");
  }
  if (!auto) {
    return undefined;
  }
  return readGithubEventSha("head", env) ?? tryGitHeadSha(cwd);
}

/** Resolve the head repo name (flag → git remote), matching the legacy CLI. */
function resolveHeadRepoName(
  flags: VcsFlags,
  cwd: string,
  auto: boolean
): string | undefined {
  return flags["head-repo-name"] || (auto ? getRepositoryName(cwd) : undefined);
}

/**
 * Resolve the base SHA: explicit flag (present, even if empty) → GitHub event
 * payload → merge-base of HEAD with the base ref (when known) or the remote's
 * default branch.
 *
 * @param baseRef - The resolved base ref (from flag/env/default); when set, the
 *   merge-base is computed against it so a user-supplied `--base-ref` is honored.
 */
function resolveBaseSha(
  flags: VcsFlags,
  baseRef: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
  auto: boolean
): string | undefined {
  if (flags["base-sha"] !== undefined) {
    return validateShaFlag(flags["base-sha"], "base-sha");
  }
  if (!auto) {
    return undefined;
  }
  const fromEvent = readGithubEventSha("base", env);
  if (fromEvent) {
    return fromEvent;
  }
  // Prefer the known base ref (try the remote-tracking ref first, then the bare
  // name); fall back to the remote's default branch head.
  const mergeBase = baseRef
    ? (getMergeBase(`origin/${baseRef}`, cwd) ?? getMergeBase(baseRef, cwd))
    : getMergeBase("refs/remotes/origin/HEAD", cwd);
  return normalizeSha(mergeBase);
}

/**
 * Collect VCS metadata from flags and (optionally) git/CI introspection.
 *
 * @param flags - The parsed git-metadata flags.
 * @param cwd - Working directory of the command.
 * @param env - Environment variables.
 * @param autoCollect - When false, only explicit flag values are used.
 */
export function collectVcsMetadata(
  flags: VcsFlags,
  cwd: string,
  env: NodeJS.ProcessEnv,
  autoCollect: boolean
): VcsInfo {
  const remoteUrl = autoCollect ? getRemoteUrl(cwd) : undefined;

  const headSha = resolveHeadSha(flags, cwd, env, autoCollect);
  const vcsProvider =
    flags["vcs-provider"] ||
    (autoCollect && remoteUrl ? providerFromRemoteUrl(remoteUrl) : undefined);
  const headRepoName = resolveHeadRepoName(flags, cwd, autoCollect);
  const headRef =
    flags["head-ref"] ||
    (autoCollect ? githubHeadRef(env) || getCurrentBranch(cwd) : undefined);
  const baseRepoName = flags["base-repo-name"] || undefined;

  const baseRefFromUser = flags["base-ref"] !== undefined;
  const baseShaFromUser = flags["base-sha"] !== undefined;
  let baseRef =
    flags["base-ref"] ||
    (autoCollect
      ? githubBaseRef(env) || getRemoteDefaultBranch(cwd)
      : undefined);
  let baseSha = resolveBaseSha(flags, baseRef, cwd, env, autoCollect);

  // If base == head and both were auto-inferred, the PR comparison is
  // meaningless — drop base_sha/base_ref but keep head_sha (matches legacy).
  if (
    !(baseShaFromUser || baseRefFromUser) &&
    baseSha &&
    headSha &&
    baseSha === headSha
  ) {
    log.debug("Base SHA equals HEAD SHA and both auto-inferred; dropping base");
    baseSha = undefined;
    baseRef = undefined;
  }

  const prNumber =
    flags["pr-number"] ?? (autoCollect ? githubPrNumber(env) : undefined);

  return {
    headSha,
    baseSha,
    vcsProvider,
    headRepoName,
    baseRepoName,
    headRef,
    baseRef,
    prNumber,
  };
}

/**
 * Flatten {@link VcsInfo} into the snake_case fields merged into the build
 * assemble body. Empty/undefined values are omitted.
 */
export function vcsInfoToBody(vcs: VcsInfo): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (vcs.headSha) {
    body.head_sha = vcs.headSha;
  }
  if (vcs.baseSha) {
    body.base_sha = vcs.baseSha;
  }
  if (vcs.vcsProvider) {
    body.provider = vcs.vcsProvider;
  }
  if (vcs.headRepoName) {
    body.head_repo_name = vcs.headRepoName;
  }
  if (vcs.baseRepoName) {
    body.base_repo_name = vcs.baseRepoName;
  }
  if (vcs.headRef) {
    body.head_ref = vcs.headRef;
  }
  if (vcs.baseRef) {
    body.base_ref = vcs.baseRef;
  }
  if (vcs.prNumber !== undefined) {
    body.pr_number = vcs.prNumber;
  }
  return body;
}
