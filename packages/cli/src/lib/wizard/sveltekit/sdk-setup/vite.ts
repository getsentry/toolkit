/**
 * Adds the Sentry SvelteKit Vite plugin to `vite.config.(js|ts)`.
 */

import { reportCliError } from "../../../error-reporting.js";
import { Sentry } from "../../telemetry.js";
import { promises } from "node:fs";
import path from "node:path";
import chalk from "chalk";

import { clack } from "../../utils/clack/prompts.js";
import { generateCode, parseModule } from "magicast";
import { addVitePlugin } from "magicast/helpers";

import type { namedTypes as t } from "ast-types";

import {
  hasSentryContent,
  preserveTrailingNewline,
} from "../../utils/ast-utils.js";
import { debug } from "../../utils/debug.js";
import { abortIfCancelled } from "../../utils/clack/index.js";
import type { ProjectInfo } from "./types.js";
import { modifyAndRecordFail } from "./utils.js";

export async function modifyViteConfig(
  viteConfigPath: string,
  projectInfo: ProjectInfo,
): Promise<void> {
  const viteConfigContent = (
    await promises.readFile(viteConfigPath, "utf-8")
  ).toString();

  const { org, project, url, selfHosted, vitePluginImportPath } = projectInfo;

  const prettyViteConfigFilename = chalk.cyan(path.basename(viteConfigPath));

  try {
    const viteModule = parseModule(viteConfigContent);

    if (hasSentryContent(viteModule.$ast as t.Program)) {
      clack.log.warn(
        `File ${prettyViteConfigFilename} already contains Sentry code.
Skipping adding Sentry functionality to.`,
      );
      Sentry.setTag(`modified-vite-cfg`, "fail");
      Sentry.setTag(`vite-cfg-fail-reason`, "has-sentry-content");
      return;
    }

    await modifyAndRecordFail(
      () =>
        addVitePlugin(viteModule, {
          imported: "sentrySvelteKit",
          from: vitePluginImportPath,
          constructor: "sentrySvelteKit",
          options: {
            org,
            project,
            ...(selfHosted && { sentryUrl: url }),
          },
          index: 0,
        }),
      "add-vite-plugin",
      "vite-cfg",
    );

    await modifyAndRecordFail(
      async () => {
        const code = preserveTrailingNewline(
          viteConfigContent,
          generateCode(viteModule.$ast).code,
        );
        await promises.writeFile(viteConfigPath, code);
      },
      "write-file",
      "vite-cfg",
    );
  } catch (e) {
    debug(e);
    await showFallbackViteCopyPasteSnippet(
      viteConfigPath,
      getViteConfigCodeSnippet(
        org,
        project,
        selfHosted,
        url,
        vitePluginImportPath,
      ),
    );
    reportCliError(new Error("Sveltekit Vite Config Modification Fail"));
  }

  clack.log.success(`Added Sentry code to ${prettyViteConfigFilename}`);
  Sentry.setTag(`modified-vite-cfg`, "success");
}

async function showFallbackViteCopyPasteSnippet(
  viteConfigPath: string,
  codeSnippet: string,
) {
  const viteConfigFilename = path.basename(viteConfigPath);

  clack.log.warning(
    `Couldn't automatically modify your ${chalk.cyan(viteConfigFilename)}
${chalk.dim(`This sometimes happens when we encounter more complex vite configs.
It may not seem like it but sometimes our magical powers are limited ;)`)}`,
  );

  clack.log.info("But don't worry - it's super easy to do this yourself!");

  clack.log.step(
    `Add the following code to your ${chalk.cyan(viteConfigFilename)}:`,
  );

  // Printed outside clack's gutter for easier copy/pasting
  clack.rawOutput(codeSnippet);

  await abortIfCancelled(
    clack.select({
      message: "Did you copy the snippet above?",
      options: [
        { label: "Yes!", value: true, hint: "Great, that's already it!" },
      ],
      initialValue: true,
    }),
  );
}

const getViteConfigCodeSnippet = (
  org: string,
  project: string,
  selfHosted: boolean,
  url: string,
  vitePluginImportPath: string,
) =>
  chalk.gray(`
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
${chalk.greenBright(
  `import { sentrySvelteKit } from '${vitePluginImportPath}'`,
)}

export default defineConfig({
  plugins: [
    // Make sure \`sentrySvelteKit\` is registered before \`sveltekit\`
    ${chalk.greenBright(`sentrySvelteKit({
      org: '${org}',
      project: '${project}',${
        selfHosted ? `\n        sentryUrl: '${url}',` : ""
      }
    }),`)}
    sveltekit(),
  ]
});
`);
