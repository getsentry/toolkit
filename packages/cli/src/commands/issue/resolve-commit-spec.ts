/**
 * Resolve `@commit` / `@commit:<repo>@<sha>` specs into a concrete
 * `{inCommit: {commit, repository}}` payload.
 *
 * The bare `@commit` form auto-detects:
 *   1. Current git HEAD SHA (must be inside a git work tree)
 *   2. Current git origin URL → parse to `owner/repo` via {@link parseRemoteUrl}
 *   3. Matching Sentry-registered repo (by `externalSlug` first, then `name`)
 *
 * The explicit form `@commit:<repo>@<sha>` skips steps 1-2 and goes straight
 * to step 3 with the user-provided repo name, but still validates that the
 * repo is registered in Sentry (otherwise the API rejects the payload).
 *
 * Every failure mode raises a `ValidationError` with a concrete remediation
 * hint — no silent fallback to another resolution mode. Per the design, a
 * half-correct `--in` request is worse than a clear error the user can fix.
 */

import { execFileSync } from "node:child_process";
import type { ResolveCommitSpec } from "../../lib/api/issues.js";
import { listRepositoriesCached } from "../../lib/api-client.js";
import { ValidationError } from "../../lib/errors.js";
import {
  getHeadCommit,
  isInsideGitWorkTree,
  parseRemoteUrl,
} from "../../lib/git.js";
import type { SentryRepository } from "../../types/index.js";

/** Fetch the git origin URL without throwing when it's missing. */
function getGitOriginUrl(cwd: string): string | undefined {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }
}

/**
 * Find the Sentry repo whose `externalSlug` or `name` matches the local
 * `owner/repo` derived from `git remote get-url origin`.
 *
 * Returns `null` when no match is found — the caller surfaces this as
 * a user-facing error with an available-repos list.
 */
function findSentryRepoMatchingOrigin(
  originOwnerRepo: string,
  sentryRepos: SentryRepository[]
): SentryRepository | null {
  // Prefer externalSlug (canonical `owner/repo` from the integration)
  // then fall back to `name` for repos without that field populated.
  const match =
    sentryRepos.find((r) => r.externalSlug === originOwnerRepo) ??
    sentryRepos.find((r) => r.name === originOwnerRepo);
  return match ?? null;
}

/**
 * Find the Sentry repo matching a user-provided repo name exactly.
 * Checks `name` first (the canonical identifier used by the API's
 * InCommitValidator) and then `externalSlug` for convenience.
 */
function findSentryRepoByName(
  repoName: string,
  sentryRepos: SentryRepository[]
): SentryRepository | null {
  return (
    sentryRepos.find((r) => r.name === repoName) ??
    sentryRepos.find((r) => r.externalSlug === repoName) ??
    null
  );
}

/** Format a short list of available repos for error messages. */
function formatAvailableRepos(repos: SentryRepository[]): string {
  if (repos.length === 0) {
    return "No repositories are registered in Sentry for this organization.";
  }
  const MAX = 10;
  const names = repos
    .slice(0, MAX)
    .map((r) => `  - ${r.name}`)
    .join("\n");
  const more =
    repos.length > MAX
      ? `\n  ... and ${repos.length - MAX} more (sentry repo list <org>/)`
      : "";
  return `Available repositories in this organization:\n${names}${more}`;
}

/**
 * Resolve a {@link ResolveCommitSpec} (either auto-detect or explicit) into
 * the concrete `{commit, repository}` payload the Sentry API expects.
 *
 * @throws {ValidationError} When any step of the resolution fails — no
 *   fallback to `inRelease` or other modes. The error message always names
 *   the next action the user can take.
 */
export async function resolveCommitSpec(
  spec: ResolveCommitSpec,
  orgSlug: string,
  cwd: string
): Promise<{ commit: string; repository: string }> {
  if (spec.kind === "auto") {
    if (!isInsideGitWorkTree(cwd)) {
      throw new ValidationError(
        "--in @commit requires a git repository. Run from inside a checkout, or use --in @next / --in <version> / --in @commit:<repo>@<sha>.",
        "in"
      );
    }

    let headSha: string;
    try {
      headSha = getHeadCommit(cwd);
    } catch {
      throw new ValidationError(
        "--in @commit could not read HEAD (is this a fresh repo with no commits?). Make a commit first, or pass --in @commit:<repo>@<sha> explicitly.",
        "in"
      );
    }

    const originUrl = getGitOriginUrl(cwd);
    if (!originUrl) {
      throw new ValidationError(
        "--in @commit could not determine the git 'origin' remote. Add an origin remote, or pass --in @commit:<repo>@<sha> explicitly.",
        "in"
      );
    }

    const originOwnerRepo = parseRemoteUrl(originUrl);
    if (!originOwnerRepo) {
      throw new ValidationError(
        `--in @commit could not parse the origin URL ('${originUrl}') as 'owner/repo'. Use --in @commit:<repo>@<sha> explicitly.`,
        "in"
      );
    }

    const sentryRepos = await listRepositoriesCached(orgSlug);
    const match = findSentryRepoMatchingOrigin(originOwnerRepo, sentryRepos);
    if (!match) {
      throw new ValidationError(
        `--in @commit: no Sentry repository matches local origin '${originOwnerRepo}' in organization '${orgSlug}'.\n\n` +
          `${formatAvailableRepos(sentryRepos)}\n\n` +
          "Register the repo in Sentry, or pass --in @commit:<repo>@<sha> with a registered name.",
        "in"
      );
    }

    return { commit: headSha, repository: match.name };
  }

  // Explicit: @commit:<repo>@<sha> — validate the repo is registered.
  const sentryRepos = await listRepositoriesCached(orgSlug);
  const match = findSentryRepoByName(spec.repository, sentryRepos);
  if (!match) {
    throw new ValidationError(
      `--in @commit:${spec.repository}@${spec.commit}: no Sentry repository named '${spec.repository}' in organization '${orgSlug}'.\n\n` +
        `${formatAvailableRepos(sentryRepos)}`,
      "in"
    );
  }
  return { commit: spec.commit, repository: match.name };
}
