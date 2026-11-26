/**
 * Source maps setup for webpack: add the Sentry webpack plugin to a CommonJS
 * webpack config and turn on `devtool: "source-map"`.
 */

import type { namedTypes as t } from "ast-types";
import chalk from "chalk";
import { promises } from "node:fs";
import path from "node:path";
import recast from "recast";

import { Sentry } from "../../telemetry.js";
import { findFile, hasSentryContent } from "../../utils/ast-utils.js";
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

const getCodeSnippet = (
  options: SourceMapUploadToolConfigurationOptions,
  colors: boolean,
  importPath: string,
) =>
  makeCodeSnippet(colors, (unchanged, plus) =>
    unchanged(`${plus(
      `const { sentryWebpackPlugin } = require("${importPath}");`,
    )}

module.exports = {
  // ... other options
  ${plus('devtool: "source-map", // Source map generation must be turned on')}
  plugins: [
    // Put the Sentry Webpack plugin after all other plugins
    ${plus(`sentryWebpackPlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: "${options.orgSlug}",
      project: "${options.projectSlug}",${
        options.selfHosted ? `\n      url: "${options.url}",` : ""
      }
    }),`)}
  ],
}`),
  );

export const configureWebPackPlugin: SourceMapUploadToolConfigurationFunction =
  async (options) => {
    const importPath = await ensureBundlerPlugin("webpack");

    const webpackConfigPath =
      findFile(path.resolve(process.cwd(), "webpack.config")) ??
      (await askForToolConfigPath("Webpack", "webpack.config.js"));

    let successfullyAdded = false;
    if (webpackConfigPath) {
      successfullyAdded = await modifyWebpackConfig(
        webpackConfigPath,
        options,
        importPath,
      );
    } else {
      successfullyAdded = await createNewConfigFile(
        path.join(process.cwd(), "webpack.config.js"),
        getCodeSnippet(options, false, importPath),
        "More information about Webpack configs: https://vitejs.dev/config/",
      );
      Sentry.setTag(
        "created-new-config",
        successfullyAdded ? "success" : "fail",
      );
    }

    if (successfullyAdded) {
      clack.log.info(
        `We recommend checking the ${
          webpackConfigPath ? "modified" : "added"
        } file after the wizard finished to ensure it works with your build setup.`,
      );

      Sentry.setTag("ast-mod", "success");
    } else {
      Sentry.setTag("ast-mod", "fail");
      await showCopyPasteInstructions({
        filename: path.basename(webpackConfigPath || "webpack.config.js"),
        codeSnippet: getCodeSnippet(options, true, importPath),
      });
    }

    await addDotEnvSentryBuildPluginFile(options.authToken);
  };

/**
 * Modifies a webpack config file to enable source map generation and add the Sentry webpack plugin
 * exported only for testing
 */
export async function modifyWebpackConfig(
  webpackConfigPath: string,
  options: SourceMapUploadToolConfigurationOptions,
  importPath: string,
): Promise<boolean> {
  try {
    const webpackConfig = await promises.readFile(webpackConfigPath, {
      encoding: "utf-8",
    });

    const prettyConfigFilename = chalk.cyan(path.basename(webpackConfigPath));

    // no idea why recast returns any here, this is dumb :/
    const program = recast.parse(webpackConfig.toString()).program as t.Program;

    if (!(await shouldModifyWebpackConfig(program, prettyConfigFilename))) {
      // Sentry tag is set in shouldModifyWebpackConfig
      return false;
    }

    const exportStmt = getCjsModuleExports(program);
    if (!exportStmt) {
      // We only care about CJS at the moment since it's probably the most widely used format for webpack configs.
      debug(`Could not find module.exports = {...} in ${webpackConfigPath}.`);
      Sentry.setTag("ast-mod-fail-reason", "config-object-not-found");
      return false;
    }

    const configObject = getWebpackConfigObject(exportStmt, program);

    if (!configObject) {
      debug(`Couldn't find config object in ${webpackConfigPath}`);
      Sentry.setTag("ast-mod-fail-reason", "config-object-not-found");
      return false;
    }

    const enabledSourcemaps = enableSourcemapsGeneration(configObject);

    if (enabledSourcemaps) {
      clack.log.success(
        `Enabled source map generation in ${prettyConfigFilename}.`,
      );
    } else {
      clack.log.warn(
        `Couldn't enable source maps generation in ${prettyConfigFilename} Please follow the instructions below.`,
      );
      Sentry.setTag("ast-mod-fail-reason", "insertion-fail");
      return false;
    }

    const addedPlugin = addSentryWebpackPlugin(
      program,
      configObject,
      options,
      importPath,
    );
    if (addedPlugin) {
      clack.log.success(
        `Added Sentry webpack plugin to ${prettyConfigFilename}.`,
      );
    } else {
      clack.log.warn(
        `Couldn't add Sentry webpack plugin to ${prettyConfigFilename}. Please follow the instructions below.`,
      );
      Sentry.setTag("ast-mod-fail-reason", "insertion-fail");
      return false;
    }

    const code = recast.print(program).code;
    await promises.writeFile(webpackConfigPath, code);

    return true;
  } catch (e) {
    Sentry.setTag("ast-mod-fail-reason", "insertion-fail");
    debug(e);
    return false;
  }
}

async function shouldModifyWebpackConfig(
  program: t.Program,
  prettyConfigFilename: string,
) {
  if (hasSentryContent(program)) {
    const shouldContinue = await abortIfCancelled(
      clack.select({
        message: `Seems like ${prettyConfigFilename} already contains Sentry-related code. Should the wizard modify it anyway?`,
        options: [
          {
            label: "Yes, add the Sentry Webpack plugin",
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

  return true;
}

function addSentryWebpackPlugin(
  program: t.Program,
  configObj: t.ObjectExpression,
  options: SourceMapUploadToolConfigurationOptions,
  importPath: string,
) {
  const b = addSentryWebpackPluginImport(program, importPath);

  const sentryPluginCall = b.callExpression(
    b.identifier("sentryWebpackPlugin"),
    [
      b.objectExpression([
        b.objectProperty(
          b.identifier("authToken"),
          b.identifier("process.env.SENTRY_AUTH_TOKEN"),
        ),
        b.objectProperty(b.identifier("org"), b.stringLiteral(options.orgSlug)),
        b.objectProperty(
          b.identifier("project"),
          b.stringLiteral(options.projectSlug),
        ),
        ...(options.selfHosted
          ? [
              b.objectProperty(
                b.identifier("url"),
                b.stringLiteral(options.url),
              ),
            ]
          : []),
      ]),
    ],
  );

  const pluginsProp = configObj.properties.find(
    (p): p is t.Property =>
      p.type === "Property" &&
      p.key.type === "Identifier" &&
      p.key.name === "plugins",
  );

  if (pluginsProp) {
    if (pluginsProp.value.type === "ArrayExpression") {
      pluginsProp.value.elements.push(sentryPluginCall);
    } else {
      pluginsProp.value = b.arrayExpression([sentryPluginCall]);
    }
    return true;
  }

  configObj.properties.push(
    b.objectProperty(
      b.identifier("plugins"),
      b.arrayExpression([sentryPluginCall]),
    ),
  );

  return true;
}

function addSentryWebpackPluginImport(program: t.Program, importPath: string) {
  const b = recast.types.builders;

  const sentryPluginRequireStmt = b.variableDeclaration("const", [
    b.variableDeclarator(
      b.objectPattern([
        b.objectProperty.from({
          key: b.identifier("sentryWebpackPlugin"),
          value: b.identifier("sentryWebpackPlugin"),
          shorthand: true,
        }),
      ]),
      b.callExpression(b.identifier("require"), [b.stringLiteral(importPath)]),
    ),
  ]);

  program.body.unshift(sentryPluginRequireStmt);
  return b;
}

function enableSourcemapsGeneration(configObj: t.ObjectExpression): boolean {
  const b = recast.types.builders;

  const devtoolProp = configObj.properties.find(
    (p): p is t.Property =>
      p.type === "Property" &&
      p.key.type === "Identifier" &&
      p.key.name === "devtool",
  );

  if (devtoolProp) {
    // devtool can have quite a lot of source maps values.
    // see: https://webpack.js.org/configuration/devtool/#devtool
    // For Sentry to work best, we should set it to "source-map" or "hidden-source-map"
    // Heuristic:
    // - all values that contain "hidden" will be set to "hidden-source-map"
    // - all other values will be set to "source-map"
    if (
      (devtoolProp.value.type === "Literal" ||
        devtoolProp.value.type === "StringLiteral") &&
      devtoolProp.value.value?.toString().startsWith("hidden-")
    ) {
      devtoolProp.value = b.stringLiteral("hidden-source-map");
    } else {
      devtoolProp.value = b.stringLiteral("source-map");
    }
    return true;
  }

  configObj.properties.push(
    b.objectProperty(b.identifier("devtool"), b.stringLiteral("source-map")),
  );

  return true;
}

function getWebpackConfigObject(
  moduleExports: t.AssignmentExpression,
  program: t.Program,
): t.ObjectExpression | undefined {
  const rhs = moduleExports.right;
  if (rhs.type === "ObjectExpression") {
    return rhs;
  }
  if (rhs.type === "Identifier") {
    const configId = rhs.name;

    const configDeclaration = program.body.find(
      (s): s is t.VariableDeclaration =>
        s.type === "VariableDeclaration" &&
        !!s.declarations.find(
          (d) =>
            d.type === "VariableDeclarator" &&
            d.id.type === "Identifier" &&
            d.id.name === configId,
        ),
    );

    const declarator = configDeclaration?.declarations.find(
      (d): d is t.VariableDeclarator =>
        d.type === "VariableDeclarator" &&
        d.id.type === "Identifier" &&
        d.id.name === configId,
    );

    return declarator?.init?.type === "ObjectExpression"
      ? declarator.init
      : undefined;
  }

  return undefined;
}

function getCjsModuleExports(
  program: t.Program,
): t.AssignmentExpression | undefined {
  const moduleExports = program.body.find(
    (s): s is t.ExpressionStatement =>
      s.type === "ExpressionStatement" &&
      s.expression.type === "AssignmentExpression" &&
      s.expression.left.type === "MemberExpression" &&
      s.expression.left.object.type === "Identifier" &&
      s.expression.left.object.name === "module" &&
      s.expression.left.property.type === "Identifier" &&
      s.expression.left.property.name === "exports",
  );
  return moduleExports?.expression as t.AssignmentExpression;
}
