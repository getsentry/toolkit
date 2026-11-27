/**
 * Give the Xcode build phase its credentials: write the auth token, org and
 * project to a `.sentryclirc` in the project directory, which `sentry` reads,
 * and keep that file out of git.
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import chalk from "chalk";

import { Sentry } from "../telemetry.js";
import { clack } from "../utils/clack/prompts.js";
import { debug } from "../utils/debug.js";

/**
 * Write `.sentryclirc` with the auth token and `[defaults]` org and project,
 * and add it to `.gitignore`.
 */
export function configureSentryCLI({
  projectDir,
  authToken,
  orgSlug,
  projectSlug,
}: {
  projectDir: string;
  authToken: string;
  orgSlug: string;
  projectSlug: string;
}): void {
  debug(`Creating sentryclirc file at path: ${chalk.cyan(projectDir)}`);
  createSentryCLIRC(projectDir, { authToken, orgSlug, projectSlug });
  clack.log.info(
    `Created a ${chalk.cyan(
      ".sentryclirc",
    )} file in your project directory with your auth token, organization, and project for the Sentry CLI.

It was also added to your ${chalk.cyan(".gitignore")} file.
In your CI environment, set the ${chalk.cyan(
      "SENTRY_AUTH_TOKEN",
    )}, ${chalk.cyan("SENTRY_ORG")}, and ${chalk.cyan(
      "SENTRY_PROJECT",
    )} environment variables, and ${chalk.cyan(
      "SENTRY_URL",
    )} for self-hosted Sentry. See https://cli.sentry.dev/configuration/ for more information.`,
  );
  Sentry.setTag("sentry-cli-configured", true);
  debug(`Sentry CLI configured: ${chalk.cyan(true.toString())}`);
}

/** Write `.sentryclirc` in `directory` and make sure git ignores it. */
function createSentryCLIRC(
  directory: string,
  {
    authToken,
    orgSlug,
    projectSlug,
  }: { authToken: string; orgSlug: string; projectSlug: string },
): void {
  const rcPath = path.join(directory, ".sentryclirc");
  writeFileSync(
    rcPath,
    `[auth]\ntoken=${authToken}\n\n[defaults]\norg=${orgSlug}\nproject=${projectSlug}\n`,
  );

  const gitignorePath = path.join(directory, ".gitignore");
  if (!existsSync(gitignorePath)) {
    clack.log.info(
      `Creating .gitignore file at path: ${chalk.cyan(gitignorePath)}`,
    );
    writeFileSync(gitignorePath, ".sentryclirc");
  } else {
    const gitIgnore = readFileSync(gitignorePath).toString();
    if (!gitIgnore.includes(".sentryclirc")) {
      clack.log.info(
        `Appending .sentryclirc to .gitignore file at path: ${chalk.cyan(
          gitignorePath,
        )}`,
      );
      appendFileSync(gitignorePath, "\n.sentryclirc\n");
    }
  }
}
