/** Shared CI detection for command telemetry and VCS metadata collection. */

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
