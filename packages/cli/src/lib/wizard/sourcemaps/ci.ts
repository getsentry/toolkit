/**
 * Help the user make the source map upload auth token available in CI.
 *
 * Shared by the framework wizards and the source maps wizard. Ported from
 * sentry-wizard's `src/sourcemaps/sourcemaps-wizard.ts`.
 */

import chalk from "chalk";
import { Sentry, traceStep } from "../telemetry.js";
import {
  abortIfCancelled,
  SENTRY_CLI_RC_FILE,
  SENTRY_DOT_ENV_FILE,
} from "../utils/clack/index.js";
import { clack } from "../utils/clack/prompts.js";
import { setupNpmScriptInCI } from "./tools/sentry-cli.js";

/** Tools that upload with `sentry` commands and read `.sentryclirc`. */
const CLI_BASED_FLOW_TOOLS: readonly string[] = [
  "sentry-cli",
  "tsc",
  "angular",
  "create-react-app",
];

/**
 * Where `sentry sourcemap upload` sends source maps. In CI it comes from
 * `SENTRY_ORG`, `SENTRY_PROJECT` and, for self-hosted Sentry, `SENTRY_URL`.
 */
export type SentryCliUploadTarget = {
  org: string;
  project: string;
  /** The self-hosted Sentry URL. Unset for sentry.io. */
  url?: string | undefined;
};

/**
 * Ask whether the user builds in CI and, if so, show the environment
 * variables to set there.
 *
 * @param selectedTool - The build tool the wizard configured, such as `nextjs`
 * @param authToken - The token written to the local config file
 * @param uploadTarget - For tools that upload with `sentry` commands, the
 *   org, project, and self-hosted URL that CI needs as well
 */
export async function setupCI(
  selectedTool: string,
  authToken: string,
  uploadTarget?: SentryCliUploadTarget,
): Promise<void> {
  await traceStep("configure-ci", () =>
    configureCI(selectedTool, authToken, uploadTarget),
  );
}

/** Ask about CI and show the environment variables to set there. */
async function configureCI(
  selectedTool: string,
  authToken: string,
  uploadTarget: SentryCliUploadTarget | undefined,
): Promise<void> {
  const isUsingCI = await abortIfCancelled(
    clack.select({
      message: `Are you using a CI/CD tool to build and deploy your application?`,
      options: [
        {
          label: "Yes",
          hint: "I use a tool like GitHub Actions, GitLab, CircleCI, TravisCI, Jenkins, Vercel, ...",
          value: true,
        },
        {
          label: "No",
          hint: "I build and deploy my application manually",
          value: false,
        },
      ],
      initialValue: true,
    }),
  );

  Sentry.setTag("using-ci", isUsingCI);

  const isCliBasedFlowTool = CLI_BASED_FLOW_TOOLS.includes(selectedTool);

  const authTokenFile = isCliBasedFlowTool
    ? SENTRY_CLI_RC_FILE
    : SENTRY_DOT_ENV_FILE;

  if (!isUsingCI) {
    clack.log.info(
      `No Problem! Just make sure that the Sentry auth token from ${chalk.cyan(
        authTokenFile,
      )} is available whenever you build and deploy your app.`,
    );
    return;
  }

  if (isCliBasedFlowTool) {
    await traceStep("ci-npm-script-setup", setupNpmScriptInCI);
  }

  await traceStep("ci-auth-token-setup", () =>
    setupAuthTokenInCI(
      authToken,
      isCliBasedFlowTool ? uploadTarget : undefined,
    ),
  );
}

/** The `NAME=value` lines to add to the CI environment. */
export function getCIEnvVars(
  authToken: string,
  uploadTarget: SentryCliUploadTarget | undefined,
): string[] {
  const lines = [`SENTRY_AUTH_TOKEN=${authToken}`];
  if (uploadTarget) {
    lines.push(
      `SENTRY_ORG=${uploadTarget.org}`,
      `SENTRY_PROJECT=${uploadTarget.project}`,
    );
    if (uploadTarget.url) {
      lines.push(`SENTRY_URL=${uploadTarget.url}`);
    }
  }
  return lines;
}

/** Show the auth token, and the upload target if any, to add to CI. */
async function setupAuthTokenInCI(
  authToken: string,
  uploadTarget: SentryCliUploadTarget | undefined,
): Promise<void> {
  clack.log.step(
    uploadTarget
      ? "Add these environment variables to your CI setup:"
      : "Add the Sentry authentication token as an environment variable to your CI setup:",
  );

  // Printed outside clack's gutter so that it can be copied/pasted directly
  clack.rawOutput(
    chalk.greenBright(`
${getCIEnvVars(authToken, uploadTarget).join("\n")}
`),
  );

  clack.log.warn(
    chalk.yellow("DO NOT commit this auth token to your repository!"),
  );

  const addedEnvVarToCI = await abortIfCancelled(
    clack.select({
      message: "Did you configure CI as shown above?",
      options: [
        { label: "Yes, continue!", value: true },
        {
          label: "I'll do it later...",
          value: false,
          hint: chalk.yellow(
            "You need to set the auth token to upload source maps in CI",
          ),
        },
      ],
      initialValue: true,
    }),
  );

  Sentry.setTag("added-env-var-to-ci", addedEnvVarToCI);

  if (!addedEnvVarToCI) {
    clack.log.info("Don't forget! :)");
  }
}
