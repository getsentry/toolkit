/**
 * Source maps setup for esbuild: install the Sentry esbuild plugin and show
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
${chalk.greenBright(
  `const { sentryEsbuildPlugin } = require("${importPath}");`,
)}

require("esbuild").build({
  ${chalk.greenBright(
    "sourcemap: true, // Source map generation must be turned on",
  )}
  plugins: [
    // Put the Sentry esbuild plugin after all other plugins
    ${chalk.greenBright(`sentryEsbuildPlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: "${options.orgSlug}",
      project: "${options.projectSlug}",${
        options.selfHosted ? `\n      url: "${options.url}",` : ""
      }
    }),`)}
  ],
});
`);

export const configureEsbuildPlugin: SourceMapUploadToolConfigurationFunction =
  async (options) => {
    const importPath = await ensureBundlerPlugin("esbuild");

    clack.log.step(`Add the following code to your esbuild config:`);

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
