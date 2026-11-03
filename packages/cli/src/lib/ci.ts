/** Shared CI detection for command telemetry and VCS metadata collection. */

import { parseRemoteUrl } from "./git.js";

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
 * Detect CI from generic or provider-specific environment markers.
 * Empty strings, "false", and "0" are ignored for each marker.
 *
 * @param env - Environment variables (defaults to `process.env`).
 */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return CI_ENV_VARS.some((name) => {
    const value = env[name];
    return (
      value !== undefined && value !== "" && value !== "false" && value !== "0"
    );
  });
}

/** Repository and commit that a CI or hosting provider exposes for a build. */
export type CiCheckout = {
  /** Repository path, e.g. `owner/repo` or `group/subgroup/project`. */
  repository: string;
  /** Commit SHA being built. */
  commit: string;
  /** Environment variables the values came from, for log output. */
  source: string;
};

/** A commit SHA: 7 to 40 hex characters. */
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Join two path parts, or `undefined` when either is missing. */
function joinRepo(owner?: string, name?: string): string | undefined {
  return owner && name ? `${owner}/${name}` : undefined;
}

/** Repository path from a clone URL (`https://host/owner/repo.git`). */
function repoFromUrl(url?: string): string | undefined {
  return url ? parseRemoteUrl(url) : undefined;
}

/**
 * Providers that expose the build's repository and commit, in detection
 * order. Each entry reads the repository path, the commit, and names the
 * variables it used.
 */
const CI_CHECKOUT_PROVIDERS: ReadonlyArray<{
  source: string;
  repository: (env: NodeJS.ProcessEnv) => string | undefined;
  commit: (env: NodeJS.ProcessEnv) => string | undefined;
}> = [
  {
    source: "GITHUB_REPOSITORY/GITHUB_SHA",
    repository: (env) => env.GITHUB_REPOSITORY,
    commit: (env) => env.GITHUB_SHA,
  },
  {
    source: "CI_PROJECT_PATH/CI_COMMIT_SHA",
    repository: (env) => env.CI_PROJECT_PATH,
    commit: (env) => env.CI_COMMIT_SHA,
  },
  {
    source: "BITBUCKET_REPO_FULL_NAME/BITBUCKET_COMMIT",
    repository: (env) => env.BITBUCKET_REPO_FULL_NAME,
    commit: (env) => env.BITBUCKET_COMMIT,
  },
  {
    source: "RENDER_GIT_REPO_SLUG/RENDER_GIT_COMMIT",
    repository: (env) => env.RENDER_GIT_REPO_SLUG,
    commit: (env) => env.RENDER_GIT_COMMIT,
  },
  {
    source:
      "RAILWAY_GIT_REPO_OWNER/RAILWAY_GIT_REPO_NAME/RAILWAY_GIT_COMMIT_SHA",
    repository: (env) =>
      joinRepo(env.RAILWAY_GIT_REPO_OWNER, env.RAILWAY_GIT_REPO_NAME),
    commit: (env) => env.RAILWAY_GIT_COMMIT_SHA,
  },
  {
    source: "CIRCLE_PROJECT_USERNAME/CIRCLE_PROJECT_REPONAME/CIRCLE_SHA1",
    repository: (env) =>
      joinRepo(env.CIRCLE_PROJECT_USERNAME, env.CIRCLE_PROJECT_REPONAME),
    commit: (env) => env.CIRCLE_SHA1,
  },
  {
    source: "BUILDKITE_REPO/BUILDKITE_COMMIT",
    repository: (env) => repoFromUrl(env.BUILDKITE_REPO),
    commit: (env) => env.BUILDKITE_COMMIT,
  },
  {
    source: "REPOSITORY_URL/COMMIT_REF (Netlify)",
    repository: (env) =>
      env.NETLIFY ? repoFromUrl(env.REPOSITORY_URL) : undefined,
    commit: (env) => env.COMMIT_REF,
  },
  {
    source: "BUILD_REPOSITORY_URI/BUILD_SOURCEVERSION (Azure Pipelines)",
    repository: (env) => repoFromUrl(env.BUILD_REPOSITORY_URI),
    commit: (env) => env.BUILD_SOURCEVERSION,
  },
];

/**
 * Read the repository and commit that the CI or hosting provider exposes for
 * the current build.
 *
 * Builds often run without a git checkout: Docker builds usually exclude
 * `.git`. `set-commits --auto` uses this when there is no
 * `origin` remote to read. Values that do not look like a commit SHA are
 * skipped.
 *
 * @param env - Environment variables (defaults to `process.env`).
 * @returns The first provider with both a repository and a commit SHA.
 */
export function getCiCheckout(
  env: NodeJS.ProcessEnv = process.env,
): CiCheckout | undefined {
  for (const provider of CI_CHECKOUT_PROVIDERS) {
    const repository = provider.repository(env)?.trim();
    const commit = provider.commit(env)?.trim();
    if (repository?.includes("/") && commit && COMMIT_SHA_RE.test(commit)) {
      return { repository, commit, source: provider.source };
    }
  }
  return;
}
