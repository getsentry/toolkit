/**
 * sentry release propose-version
 *
 * Propose a release version by checking CI environment variables,
 * falling back to the current git HEAD SHA.
 *
 * Detection order (matching the original sentry-cli):
 * 1. SENTRY_RELEASE env var
 * 2. SOURCE_VERSION (Heroku)
 * 3. HEROKU_BUILD_COMMIT / HEROKU_SLUG_COMMIT
 * 4. CODEBUILD_RESOLVED_SOURCE_VERSION (AWS CodeBuild)
 * 5. CIRCLE_SHA1 (CircleCI)
 * 6. CF_PAGES_COMMIT_SHA (Cloudflare Pages)
 * 7. GAE_DEPLOYMENT_ID (Google App Engine)
 * 8. GITHUB_SHA (GitHub Actions)
 * 9. VERCEL_GIT_COMMIT_SHA (Vercel)
 * 10. RENDER_GIT_COMMIT (Render)
 * 11. NETLIFY_COMMIT_SHA (Netlify)
 * 12. CI_COMMIT_SHA (GitLab CI)
 * 13. BITBUCKET_COMMIT (Bitbucket Pipelines)
 * 14. TRAVIS_COMMIT (Travis CI)
 * 15. Git HEAD SHA (fallback)
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { getHeadCommit } from "../../lib/git.js";

type ProposeVersionResult = {
  version: string;
  source: string;
};

function formatProposedVersion(result: ProposeVersionResult): string {
  return result.version;
}

/**
 * CI environment variables checked in priority order.
 * Each entry: [env var name, human-readable source label].
 */
const CI_ENV_VARS: ReadonlyArray<readonly [string, string]> = [
  ["SENTRY_RELEASE", "SENTRY_RELEASE"],
  ["SOURCE_VERSION", "SOURCE_VERSION (Heroku)"],
  ["HEROKU_BUILD_COMMIT", "HEROKU_BUILD_COMMIT"],
  ["HEROKU_SLUG_COMMIT", "HEROKU_SLUG_COMMIT"],
  [
    "CODEBUILD_RESOLVED_SOURCE_VERSION",
    "CODEBUILD_RESOLVED_SOURCE_VERSION (AWS)",
  ],
  ["CIRCLE_SHA1", "CIRCLE_SHA1 (CircleCI)"],
  ["CF_PAGES_COMMIT_SHA", "CF_PAGES_COMMIT_SHA (Cloudflare)"],
  ["GAE_DEPLOYMENT_ID", "GAE_DEPLOYMENT_ID (Google App Engine)"],
  ["GITHUB_SHA", "GITHUB_SHA (GitHub Actions)"],
  ["VERCEL_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_SHA (Vercel)"],
  ["RENDER_GIT_COMMIT", "RENDER_GIT_COMMIT (Render)"],
  ["NETLIFY_COMMIT_SHA", "NETLIFY_COMMIT_SHA (Netlify)"],
  ["CI_COMMIT_SHA", "CI_COMMIT_SHA (GitLab CI)"],
  ["BITBUCKET_COMMIT", "BITBUCKET_COMMIT (Bitbucket Pipelines)"],
  ["TRAVIS_COMMIT", "TRAVIS_COMMIT (Travis CI)"],
];

export const proposeVersionCommand = buildCommand({
  docs: {
    brief: "Propose a release version",
    fullDescription:
      "Propose a release version from CI environment variables or git HEAD SHA.\n\n" +
      "Detection order:\n" +
      "  1. SENTRY_RELEASE env var\n" +
      "  2. SOURCE_VERSION (Heroku)\n" +
      "  3. HEROKU_BUILD_COMMIT / HEROKU_SLUG_COMMIT\n" +
      "  4. CODEBUILD_RESOLVED_SOURCE_VERSION (AWS CodeBuild)\n" +
      "  5. CIRCLE_SHA1 (CircleCI)\n" +
      "  6. CF_PAGES_COMMIT_SHA (Cloudflare Pages)\n" +
      "  7. GAE_DEPLOYMENT_ID (Google App Engine)\n" +
      "  8. GITHUB_SHA (GitHub Actions)\n" +
      "  9. VERCEL_GIT_COMMIT_SHA (Vercel)\n" +
      "  10. RENDER_GIT_COMMIT (Render)\n" +
      "  11. NETLIFY_COMMIT_SHA (Netlify)\n" +
      "  12. CI_COMMIT_SHA (GitLab CI)\n" +
      "  13. BITBUCKET_COMMIT (Bitbucket Pipelines)\n" +
      "  14. TRAVIS_COMMIT (Travis CI)\n" +
      "  15. Git HEAD SHA (fallback)\n\n" +
      "Useful in CI scripts:\n" +
      "  sentry release create $(sentry release propose-version)\n\n" +
      "Examples:\n" +
      "  sentry release propose-version\n" +
      "  sentry release propose-version --json",
  },
  output: {
    human: formatProposedVersion,
  },
  parameters: {},
  async *func(
    this: SentryContext,
    _flags: { readonly json: boolean; readonly fields?: string[] }
  ) {
    const { cwd, env } = this;

    // Check CI environment variables in priority order
    for (const [envVar, source] of CI_ENV_VARS) {
      const value = env[envVar]?.trim();
      if (value) {
        yield new CommandOutput({ version: value, source });
        return { hint: `Detected from ${source}` };
      }
    }

    // Fall back to git HEAD SHA
    const sha = await getHeadCommit(cwd);
    yield new CommandOutput({ version: sha, source: "git" });
    return { hint: "Detected from git HEAD" };
  },
});
