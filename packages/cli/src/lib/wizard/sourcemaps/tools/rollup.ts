/**
 * Source maps setup for Rollup: install the Sentry Rollup plugin and show
 * the config change to make.
 */

import chalk from "chalk";
import {
  abortIfCancelled,
  addDotEnvSentryBuildPluginFile,
} from "../../utils/clack/index.js";
import { clack } from "../../utils/clack/prompts.js";
import { ensureBundlerPlugin } from "../utils/bundler-plugin.js";

import type {
  SourceMapUploadToolConfigurationFunction,
  SourceMapUploadToolConfigurationOptions,
} from "./types.js";

const getCodeSnippet = (
  options: SourceMapUploadToolConfigurationOptions,
  importPath: string,
) =>
  chalk.gray(`
${chalk.greenBright(`import { sentryRollupPlugin } from "${importPath}";`)}

export default {
  output: {
    ${chalk.greenBright(
      "sourcemap: true, // Source map generation must be turned on",
    )}
  },
  plugins: [
    // Put the Sentry rollup plugin after all other plugins
    ${chalk.greenBright(`sentryRollupPlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: "${options.orgSlug}",
      project: "${options.projectSlug}",${
        options.selfHosted ? `\n      url: "${options.url}",` : ""
      }
    }),`)}
  ],
};
`);

export const configureRollupPlugin: SourceMapUploadToolConfigurationFunction =
  async (options) => {
    const importPath = await ensureBundlerPlugin("rollup");

    clack.log.step(`Add the following code to your rollup config:`);

    // Printed outside clack's gutter so that it can be copied/pasted directly
    clack.rawOutput(getCodeSnippet(options, importPath));

    await abortIfCancelled(
      clack.select({
        message: "Did you copy the snippet above?",
        options: [{ label: "Yes, continue!", value: true }],
        initialValue: true,
      }),
    );

    await addDotEnvSentryBuildPluginFile(options.authToken);
  };
