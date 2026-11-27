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

/** Tools that upload with `sentry` commands and read `.sentryclirc`. */
const CLI_BASED_FLOW_TOOLS: readonly string[] = [
  "sentry-cli",
  "tsc",
  "angular",
  "create-react-app",
];

/**
 * Ask whether the user builds in CI and, if so, show the auth token to set
 * there.
 *
 * @param selectedTool - The build tool the wizard configured, such as `nextjs`
 * @param authToken - The token written to the local config file
 */
export async function setupCI(
  selectedTool: string,
  authToken: string,
): Promise<void> {
  await traceStep("configure-ci", () => configureCI(selectedTool, authToken));
}

/** Ask about CI and show the auth token to set there. */
async function configureCI(
  selectedTool: string,
  authToken: string,
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

  const authTokenFile = CLI_BASED_FLOW_TOOLS.includes(selectedTool)
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

  await traceStep("ci-auth-token-setup", () => setupAuthTokenInCI(authToken));
}

/** Show the auth token to add to the CI environment. */
async function setupAuthTokenInCI(authToken: string): Promise<void> {
  clack.log.step(
    "Add the Sentry authentication token as an environment variable to your CI setup:",
  );

  // Printed outside clack's gutter so that it can be copied/pasted directly
  clack.rawOutput(
    chalk.greenBright(`
SENTRY_AUTH_TOKEN=${authToken}
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
