/**
 * Source maps setup for Vite: add the Sentry Vite plugin to the Vite config
 * and turn on `build.sourcemap`.
 */

import type { namedTypes as t } from "ast-types";
import chalk from "chalk";
import { generateCode, parseModule } from "magicast";
import { addVitePlugin } from "magicast/helpers";
import { promises } from "node:fs";
import path from "node:path";
import recast from "recast";

import { Sentry } from "../../telemetry.js";
import {
  hasSentryContent,
  preserveTrailingNewline,
} from "../../utils/ast-utils.js";
import { findFile } from "../../../dsn/fs-utils.js";
import {
  abortIfCancelled,
  addDotEnvSentryBuildPluginFile,
  askForToolConfigPath,
  createNewConfigFile,
  makeCodeSnippet,
  showCopyPasteInstructions,
} from "../../utils/clack/index.js";
import { clack } from "../../utils/clack/prompts.js";
import { debug } from "../../utils/debug.js";
import { ensureBundlerPlugin } from "../utils/bundler-plugin.js";
import type {
  SourceMapUploadToolConfigurationFunction,
  SourceMapUploadToolConfigurationOptions,
} from "./types.js";

const getViteConfigSnippet = (
  options: SourceMapUploadToolConfigurationOptions,
  colors: boolean,
  importPath: string,
) =>
  makeCodeSnippet(colors, (unchanged, plus, _) =>
    unchanged(`import { defineConfig } from "vite";
${plus(`import { sentryVitePlugin } from "${importPath}";`)}

export default defineConfig({
  build: {
    ${plus("sourcemap: true, // Source map generation must be turned on")}
  },
  plugins: [
    // Put the Sentry vite plugin after all other plugins
    ${plus(`sentryVitePlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: "${options.orgSlug}",
      project: "${options.projectSlug}",${
        options.selfHosted ? `\n      url: "${options.url}",` : ""
      }
    }),`)}
  ],
});`),
  );

export const configureVitePlugin: SourceMapUploadToolConfigurationFunction =
  async (options) => {
    const importPath = await ensureBundlerPlugin("vite");

    const viteConfigPath =
      (await findFile(path.resolve(process.cwd(), "vite.config"))) ??
      (await askForToolConfigPath("Vite", "vite.config.js"));

    let successfullyAdded = false;
    if (viteConfigPath) {
      successfullyAdded = await addVitePluginToConfig(
        viteConfigPath,
        options,
        importPath,
      );
    } else {
      successfullyAdded = await createNewConfigFile(
        path.join(process.cwd(), "vite.config.js"),
        getViteConfigSnippet(options, false, importPath),
        "More information about vite configs: https://vitejs.dev/config/",
      );
      Sentry.setTag(
        "created-new-config",
        successfullyAdded ? "success" : "fail",
      );
    }

    if (successfullyAdded) {
      clack.log.info(
        `We recommend checking the ${
          viteConfigPath ? "modified" : "added"
        } file after the wizard finished to ensure it works with your build setup.`,
      );

      Sentry.setTag("ast-mod", "success");
    } else {
      Sentry.setTag("ast-mod", "fail");
      await showCopyPasteInstructions({
        filename: path.basename(viteConfigPath || "vite.config.js"),
        codeSnippet: getViteConfigSnippet(options, true, importPath),
      });
    }

    await addDotEnvSentryBuildPluginFile(options.authToken);
  };

export async function addVitePluginToConfig(
  viteConfigPath: string,
  options: SourceMapUploadToolConfigurationOptions,
  importPath: string,
): Promise<boolean> {
  try {
    const prettyViteConfigFilename = chalk.cyan(path.basename(viteConfigPath));

    const viteConfigContent = (
      await promises.readFile(viteConfigPath)
    ).toString();

    const mod = parseModule(viteConfigContent);

    if (hasSentryContent(mod.$ast as t.Program)) {
      const shouldContinue = await abortIfCancelled(
        clack.select({
          message: `${prettyViteConfigFilename} already contains Sentry-related code. Should the wizard modify it anyway?`,
          options: [
            {
              label: "Yes, add the Sentry Vite plugin",
              value: true,
            },
            {
              label: "No, show me instructions to manually add the plugin",
              value: false,
            },
          ],
          initialValue: true,
        }),
      );

      if (!shouldContinue) {
        Sentry.setTag("ast-mod-fail-reason", "has-sentry-content");
        return false;
      }
    }

    const enabledSourcemaps = enableSourcemapGeneration(mod.$ast as t.Program);
    if (!enabledSourcemaps) {
      Sentry.setTag("ast-mod-fail-reason", "insertion-fail");
      return false;
    }

    const { orgSlug: org, projectSlug: project, selfHosted, url } = options;

    addVitePlugin(mod, {
      imported: "sentryVitePlugin",
      from: importPath,
      constructor: "sentryVitePlugin",
      options: {
        org,
        project,
        ...(selfHosted && { url }),
      },
    });

    const code = preserveTrailingNewline(
      viteConfigContent,
      generateCode(mod.$ast).code,
    );

    await promises.writeFile(viteConfigPath, code);

    clack.log.success(
      `Added the Sentry Vite plugin to ${prettyViteConfigFilename} and enabled source maps`,
    );

    return true;
  } catch (e) {
    debug(e);
    Sentry.setTag("ast-mod-fail-reason", "insertion-fail");
    return false;
  }
}

function enableSourcemapGeneration(program: t.Program): boolean {
  const configObj = getViteConfigObject(program);

  if (!configObj) {
    return false;
  }

  const b = recast.types.builders;

  const buildProp = findPropertyByName(configObj.properties, "build");

  // case 1: build property doesn't exist yet, so we can just add it
  if (!buildProp) {
    configObj.properties.push(
      b.objectProperty(
        b.identifier("build"),
        b.objectExpression([
          b.objectProperty(b.identifier("sourcemap"), b.booleanLiteral(true)),
        ]),
      ),
    );
    return true;
  }

  if (
    buildProp.type !== "ObjectProperty" ||
    buildProp.value.type !== "ObjectExpression"
  ) {
    return false;
  }

  const buildObj = buildProp.value;
  const sourceMapsProp = findPropertyByName(buildObj.properties, "sourcemap");

  // case 2: build.sourcemap property doesn't exist yet, so we just add it
  if (!sourceMapsProp) {
    buildObj.properties.push(
      b.objectProperty(b.identifier("sourcemap"), b.booleanLiteral(true)),
    );
    return true;
  }

  if (sourceMapsProp.type !== "ObjectProperty") {
    return false;
  }

  // case 3: build.sourcemap property exists, and it's set to 'hidden'
  if (
    sourceMapsProp.value.type === "StringLiteral" &&
    sourceMapsProp.value.value === "hidden"
  ) {
    // nothing to do for us
    return true;
  }

  // case 4: build.sourcemap property exists, but it's not enabled, so we set it to true
  //         or it is already true in which case this is a noop
  sourceMapsProp.value = b.booleanLiteral(true);
  return true;
}

/** The property of `properties` whose identifier key is `name`. */
function findPropertyByName(
  properties: t.ObjectExpression["properties"],
  name: string,
): t.ObjectMethod | t.ObjectProperty | t.Property | undefined {
  return properties.find(
    (p): p is t.ObjectMethod | t.ObjectProperty | t.Property =>
      "key" in p && p.key.type === "Identifier" && p.key.name === name,
  );
}

function getViteConfigObject(
  program: t.Program,
): t.ObjectExpression | undefined {
  const defaultExport = program.body.find(
    (s): s is t.ExportDefaultDeclaration =>
      s.type === "ExportDefaultDeclaration",
  );

  if (!defaultExport) {
    return undefined;
  }

  if (defaultExport.declaration.type === "ObjectExpression") {
    return defaultExport.declaration;
  }

  if (defaultExport.declaration.type === "CallExpression") {
    const [firstArg] = defaultExport.declaration.arguments;
    if (firstArg?.type === "ObjectExpression") {
      return firstArg;
    }
  }

  if (defaultExport.declaration.type === "Identifier") {
    const configId = defaultExport.declaration.name;
    return findConfigNode(configId, program);
  }

  return undefined;
}

function findConfigNode(
  configId: string,
  program: t.Program,
): t.ObjectExpression | undefined {
  for (const node of program.body) {
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        if (
          declaration.type === "VariableDeclarator" &&
          declaration.id.type === "Identifier" &&
          declaration.id.name === configId &&
          declaration.init?.type === "ObjectExpression"
        ) {
          return declaration.init;
        }
      }
    }
  }
  return undefined;
}
