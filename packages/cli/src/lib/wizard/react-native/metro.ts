/**
 * Add Sentry to a bare React Native project's Metro config through
 * `withSentryConfig`.
 */

import { clack } from "../utils/clack/prompts.js";
import { reportCliError } from "../../error-reporting.js";
import { type ProxifiedModule, parseModule, writeFile } from "magicast";
import { existsSync, promises } from "node:fs";
import { Sentry } from "../telemetry.js";

import { getLastRequireIndex, hasSentryContent } from "../utils/ast-utils.js";
import {
  abortIfCancelled,
  makeCodeSnippet,
  showCopyPasteInstructions,
} from "../utils/clack/index.js";

import recast from "recast";
import type { namedTypes as t } from "ast-types";
import chalk from "chalk";

const b = recast.types.builders;

const METRO_CONFIG_FILENAMES = ["metro.config.js", "metro.config.cjs"];

export function findMetroConfigPath(): string | undefined {
  return METRO_CONFIG_FILENAMES.find((filename) => existsSync(filename));
}

export async function patchMetroWithSentryConfig() {
  const metroConfigPath = findMetroConfigPath();

  if (!metroConfigPath) {
    clack.log.error(
      `No Metro config file found. Expected: ${METRO_CONFIG_FILENAMES.join(
        " or ",
      )}`,
    );
    // Fallback to .js for manual instructions
    return await showCopyPasteInstructions({
      filename: "metro.config.js",
      codeSnippet: getMetroWithSentryConfigSnippet(true),
    });
  }

  const showInstructions = () =>
    showCopyPasteInstructions({
      filename: metroConfigPath,
      codeSnippet: getMetroWithSentryConfigSnippet(true),
    });

  const mod = await parseMetroConfig(metroConfigPath);
  if (!mod) {
    clack.log.error(
      `Could not read from file ${chalk.cyan(
        metroConfigPath,
      )}, please follow the manual steps.`,
    );
    return await showInstructions();
  }

  const success = await patchMetroWithSentryConfigInMemory(
    mod,
    metroConfigPath,
  );
  if (!success) {
    return;
  }

  const saved = await writeMetroConfig(mod, metroConfigPath);
  if (saved) {
    clack.log.success(
      chalk.green(`${chalk.cyan(metroConfigPath)} changes saved.`),
    );
  } else {
    clack.log.warn(
      `Could not save changes to ${chalk.cyan(
        metroConfigPath,
      )}, please follow the manual steps.`,
    );
    return await showInstructions();
  }
}

export async function patchMetroWithSentryConfigInMemory(
  mod: ProxifiedModule,
  metroConfigPath: string,
  skipInstructions = false,
): Promise<boolean> {
  const showInstructions = () => {
    if (skipInstructions) {
      return Promise.resolve();
    }
    return showCopyPasteInstructions({
      filename: metroConfigPath,
      codeSnippet: getMetroWithSentryConfigSnippet(true),
    });
  };

  if (hasSentryContent(mod.$ast as t.Program)) {
    const shouldContinue = await confirmPathMetroConfig();
    if (!shouldContinue) {
      await showInstructions();
      return false;
    }
  }

  const configExpression = getModuleExportsAssignmentRight(
    mod.$ast as t.Program,
  );
  if (!configExpression) {
    clack.log.warn(
      "Could not find Metro config, please follow the manual steps.",
    );
    reportCliError(new Error("Could not find Metro config."));
    await showInstructions();
    return false;
  }

  const wrappedConfig = wrapWithSentryConfig(configExpression);

  const replacedModuleExportsRight = replaceModuleExportsRight(
    mod.$ast as t.Program,
    wrappedConfig,
  );
  if (!replacedModuleExportsRight) {
    clack.log.warn(
      "Could not automatically wrap the config export, please follow the manual steps.",
    );
    reportCliError(
      new Error("Could not automatically wrap the config export."),
    );
    await showInstructions();
    return false;
  }

  const addedSentryMetroImport = addSentryMetroRequireToMetroConfig(
    mod.$ast as t.Program,
  );
  if (!addedSentryMetroImport) {
    clack.log.warn(
      "Could not add `@sentry/react-native/metro` import to Metro config, please follow the manual steps.",
    );
    reportCliError(
      new Error(
        "Could not add `@sentry/react-native/metro` import to Metro config.",
      ),
    );
    await showInstructions();
    return false;
  }

  clack.log.success(
    `Added Sentry Metro plugin to ${chalk.cyan(metroConfigPath)}.`,
  );
  return true;
}

export async function parseMetroConfig(
  configPath: string,
): Promise<ProxifiedModule | undefined> {
  try {
    const metroConfigContent = (await promises.readFile(configPath)).toString();

    return parseModule(metroConfigContent);
  } catch (error) {
    clack.log.error(
      `Could not read Metro config file ${chalk.cyan(configPath)}`,
    );
    reportCliError(new Error("Could not read Metro config file"));
    return undefined;
  }
}

export async function writeMetroConfig(
  mod: ProxifiedModule,
  configPath: string,
): Promise<boolean> {
  try {
    await writeFile(mod.$ast, configPath);
  } catch (e) {
    clack.log.error(
      `Failed to write to ${chalk.cyan(configPath)}: ${JSON.stringify(e)}`,
    );
    reportCliError(new Error("Failed to write to Metro config file"));
    return false;
  }
  return true;
}

export function addSentrySerializerToMetroConfig(
  configObj: t.ObjectExpression,
): boolean {
  const serializerProp = getSerializerProp(configObj);
  if ("invalid" === serializerProp) {
    return false;
  }

  // case 1: serializer property doesn't exist yet, so we can just add it
  if ("undefined" === serializerProp) {
    configObj.properties.push(
      b.objectProperty(
        b.identifier("serializer"),
        b.objectExpression([
          b.objectProperty(
            b.identifier("customSerializer"),
            b.callExpression(b.identifier("createSentryMetroSerializer"), []),
          ),
        ]),
      ),
    );
    return true;
  }

  const customSerializerProp = getCustomSerializerProp(serializerProp);
  // case 2: serializer.customSerializer property doesn't exist yet, so we just add it
  if (
    "undefined" === customSerializerProp &&
    serializerProp.value.type === "ObjectExpression"
  ) {
    serializerProp.value.properties.push(
      b.objectProperty(
        b.identifier("customSerializer"),
        b.callExpression(b.identifier("createSentryMetroSerializer"), []),
      ),
    );
    return true;
  }

  return false;
}

function getCustomSerializerProp(
  prop: t.ObjectProperty,
): t.ObjectProperty | "undefined" | "invalid" {
  const customSerializerProp =
    prop.value.type === "ObjectExpression" &&
    prop.value.properties.find(
      (p) =>
        "key" in p &&
        p.key.type === "Identifier" &&
        p.key.name === "customSerializer",
    );

  if (!customSerializerProp) {
    return "undefined";
  }

  if (customSerializerProp.type === "ObjectProperty") {
    return customSerializerProp;
  }

  return "invalid";
}

function getSerializerProp(
  obj: t.ObjectExpression,
): t.ObjectProperty | "undefined" | "invalid" {
  const serializerProp = obj.properties.find(
    (p) =>
      "key" in p && p.key.type === "Identifier" && p.key.name === "serializer",
  );

  if (!serializerProp) {
    return "undefined";
  }

  if (serializerProp.type === "ObjectProperty") {
    return serializerProp;
  }

  return "invalid";
}

export function addSentrySerializerRequireToMetroConfig(
  program: t.Program,
): boolean {
  const lastRequireIndex = getLastRequireIndex(program);
  const sentrySerializerRequire = createSentrySerializerRequire();
  const sentryImportIndex = lastRequireIndex + 1;
  if (sentryImportIndex < program.body.length) {
    // insert after last require
    program.body.splice(lastRequireIndex + 1, 0, sentrySerializerRequire);
  } else {
    // insert at the beginning
    program.body.unshift(sentrySerializerRequire);
  }
  return true;
}

export function addSentryMetroRequireToMetroConfig(
  program: t.Program,
): boolean {
  const lastRequireIndex = getLastRequireIndex(program);
  const sentryMetroRequire = createSentryMetroRequire();
  const sentryImportIndex = lastRequireIndex + 1;
  if (sentryImportIndex < program.body.length) {
    // insert after last require
    program.body.splice(lastRequireIndex + 1, 0, sentryMetroRequire);
  } else {
    // insert at the beginning
    program.body.unshift(sentryMetroRequire);
  }
  return true;
}

function wrapWithSentryConfig(
  configObj: t.Identifier | t.CallExpression | t.ObjectExpression,
): t.CallExpression {
  return b.callExpression(b.identifier("withSentryConfig"), [configObj]);
}

function replaceModuleExportsRight(
  program: t.Program,
  wrappedConfig: t.CallExpression,
): boolean {
  const moduleExports = getModuleExports(program);
  if (!moduleExports) {
    return false;
  }

  if (moduleExports.expression.type === "AssignmentExpression") {
    moduleExports.expression.right = wrappedConfig;
    return true;
  }

  return false;
}

/**
 * Creates const {createSentryMetroSerializer} = require('@sentry/react-native/dist/js/tools/sentryMetroSerializer');
 */
function createSentrySerializerRequire() {
  return b.variableDeclaration("const", [
    b.variableDeclarator(
      b.objectPattern([
        b.objectProperty.from({
          key: b.identifier("createSentryMetroSerializer"),
          value: b.identifier("createSentryMetroSerializer"),
          shorthand: true,
        }),
      ]),
      b.callExpression(b.identifier("require"), [
        b.literal("@sentry/react-native/dist/js/tools/sentryMetroSerializer"),
      ]),
    ),
  ]);
}

/**
 * Creates const {withSentryConfig} = require('@sentry/react-native/metro');
 */
function createSentryMetroRequire() {
  return b.variableDeclaration("const", [
    b.variableDeclarator(
      b.objectPattern([
        b.objectProperty.from({
          key: b.identifier("withSentryConfig"),
          value: b.identifier("withSentryConfig"),
          shorthand: true,
        }),
      ]),
      b.callExpression(b.identifier("require"), [
        b.literal("@sentry/react-native/metro"),
      ]),
    ),
  ]);
}

async function confirmPathMetroConfig() {
  const shouldContinue = await abortIfCancelled(
    clack.select({
      message: `Metro Config already contains Sentry-related code. Should the wizard modify it anyway?`,
      options: [
        {
          label: "Yes, add the Sentry Metro plugin",
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
  }

  return shouldContinue;
}

/**
 * Returns value from `module.exports = value` or `const config = value`
 */
export function getMetroConfigObject(
  program: t.Program,
): t.ObjectExpression | undefined {
  // check config variable
  const configVariable = program.body.find((s) => {
    if (s.type !== "VariableDeclaration" || s.declarations.length !== 1) {
      return false;
    }
    const [declaration] = s.declarations;
    return (
      declaration?.type === "VariableDeclarator" &&
      declaration.id.type === "Identifier" &&
      declaration.id.name === "config"
    );
  }) as t.VariableDeclaration | undefined;

  const configDeclaration = configVariable?.declarations[0];
  if (
    configDeclaration?.type === "VariableDeclarator" &&
    configDeclaration.init?.type === "ObjectExpression"
  ) {
    Sentry.setTag("metro-config", "config-variable");
    return configDeclaration.init;
  }

  return getModuleExportsObject(program);
}

function getModuleExportsObject(
  program: t.Program,
): t.ObjectExpression | undefined {
  // check module.exports
  const moduleExports = getModuleExportsAssignmentRight(program);

  if (moduleExports?.type === "ObjectExpression") {
    return moduleExports;
  }

  Sentry.setTag("metro-config", "not-found");
  return undefined;
}

export function getModuleExportsAssignmentRight(
  program: t.Program,
): t.Identifier | t.CallExpression | t.ObjectExpression | undefined {
  // check module.exports
  const moduleExports = getModuleExports(program);

  if (
    moduleExports?.expression.type === "AssignmentExpression" &&
    (moduleExports.expression.right.type === "ObjectExpression" ||
      moduleExports.expression.right.type === "CallExpression" ||
      moduleExports.expression.right.type === "Identifier")
  ) {
    Sentry.setTag("metro-config", "module-exports");
    return moduleExports.expression.right;
  }

  Sentry.setTag("metro-config", "not-found");
  return undefined;
}

function getModuleExports(
  program: t.Program,
): t.ExpressionStatement | undefined {
  // find module.exports
  return program.body.find((s) => {
    if (
      s.type === "ExpressionStatement" &&
      s.expression.type === "AssignmentExpression" &&
      s.expression.left.type === "MemberExpression" &&
      s.expression.left.object.type === "Identifier" &&
      s.expression.left.object.name === "module" &&
      s.expression.left.property.type === "Identifier" &&
      s.expression.left.property.name === "exports"
    ) {
      return true;
    }
    return false;
  }) as t.ExpressionStatement | undefined;
}

function getMetroWithSentryConfigSnippet(colors: boolean) {
  return makeCodeSnippet(colors, (unchanged, plus, _) =>
    unchanged(`const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');";
${plus("const {withSentryConfig} = require('@sentry/react-native/metro');")}

const config = {};

module.exports = ${plus(
      "withSentryConfig(",
    )}mergeConfig(getDefaultConfig(__dirname), config)${plus(")")};
`),
  );
}
