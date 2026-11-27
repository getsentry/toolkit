/**
 * Add Sentry to an Expo project's Metro config through
 * `getSentryExpoConfig`.
 */

import { existsSync, promises } from "node:fs";
import { reportCliError } from "../../error-reporting.js";
import { clack } from "../utils/clack/prompts.js";
import type { ProxifiedModule } from "magicast";
import chalk from "chalk";
import { Sentry } from "../telemetry.js";

import { getLastRequireIndex, hasSentryContent } from "../utils/ast-utils.js";
import {
  makeCodeSnippet,
  showCopyPasteInstructions,
} from "../utils/clack/index.js";

import {
  findMetroConfigPath,
  parseMetroConfig,
  writeMetroConfig,
} from "./metro.js";

import recast from "recast";
import type { namedTypes as t } from "ast-types";

const b = recast.types.builders;

export async function addSentryToExpoMetroConfig() {
  let metroConfigPath = findMetroConfigPath();

  if (!metroConfigPath) {
    // No existing metro config found, create metro.config.js (Expo default)
    metroConfigPath = "metro.config.js";
  }

  if (!existsSync(metroConfigPath)) {
    const success = await createSentryExpoMetroConfig(metroConfigPath);
    if (!success) {
      Sentry.setTag("expo-metro-config", "create-new-error");
      return await showInstructions(metroConfigPath);
    }
    Sentry.setTag("expo-metro-config", "created-new");
    return undefined;
  }

  Sentry.setTag("expo-metro-config", "exists");
  clack.log.info(`Updating existing ${metroConfigPath}.`);

  const mod = await parseMetroConfig(metroConfigPath);
  if (!mod) {
    return await showInstructions(metroConfigPath);
  }

  let didPatch = false;
  try {
    didPatch = patchMetroInMemory(mod, metroConfigPath);
  } catch (e) {
    reportCliError(new Error("Unable to patch expo metro config"));
  }
  if (!didPatch) {
    Sentry.setTag("expo-metro-config", "patch-error");
    clack.log.error(
      `Could not patch ${chalk.cyan(
        metroConfigPath,
      )} with Sentry configuration.`,
    );
    return await showInstructions(metroConfigPath);
  }

  const saved = await writeMetroConfig(mod, metroConfigPath);
  if (saved) {
    Sentry.setTag("expo-metro-config", "patch-saved");
    clack.log.success(
      chalk.green(`${chalk.cyan(metroConfigPath)} changes saved.`),
    );
  } else {
    Sentry.setTag("expo-metro-config", "patch-save-error");
    clack.log.error(
      `Could not save changes to ${chalk.cyan(
        metroConfigPath,
      )}, please follow the manual steps.`,
    );
    return await showInstructions(metroConfigPath);
  }
}

export function patchMetroInMemory(
  mod: ProxifiedModule,
  metroConfigPath: string,
): boolean {
  const ast = mod.$ast as t.Program;

  if (hasSentryContent(ast)) {
    clack.log.warn(
      `The ${chalk.cyan(
        metroConfigPath,
      )} file already has Sentry configuration.`,
    );
    return false;
  }

  // Set in the visitor below, which TypeScript can't follow.
  let didReplaceDefaultConfigCall = false as boolean;

  recast.visit(ast, {
    visitVariableDeclaration(path) {
      const { node } = path;

      const declaration = node.declarations[0];
      const init =
        declaration?.type === "VariableDeclarator" ? declaration.init : null;
      const requiredModule =
        init?.type === "CallExpression" ? init.arguments[0] : undefined;
      const destructured =
        declaration?.type === "VariableDeclarator" &&
        declaration.id.type === "ObjectPattern" &&
        declaration.id.properties.length === 1
          ? declaration.id.properties[0]
          : undefined;
      if (
        // path is require("expo/metro-config")
        // and only getDefaultConfig is being destructured
        // then remove the entire declaration
        init?.type === "CallExpression" &&
        init.callee.type === "Identifier" &&
        init.callee.name === "require" &&
        requiredModule?.type === "StringLiteral" &&
        requiredModule.value === "expo/metro-config" &&
        destructured?.type === "ObjectProperty" &&
        destructured.key.type === "Identifier" &&
        destructured.key.name === "getDefaultConfig"
      ) {
        path.prune();
        return false;
      }

      this.traverse(path);
      return undefined;
    },

    visitCallExpression(path) {
      const { node } = path;
      if (
        // path is getDefaultConfig
        // then rename it to getSentryExpoConfig
        node.callee.type === "Identifier" &&
        node.callee.name === "getDefaultConfig"
      ) {
        node.callee.name = "getSentryExpoConfig";
        didReplaceDefaultConfigCall = true;
        return false;
      }

      this.traverse(path);
      return undefined;
    },
  });

  if (!didReplaceDefaultConfigCall) {
    clack.log.warn(
      `Could not find \`getDefaultConfig\` in ${chalk.cyan(metroConfigPath)}.`,
    );
    return false;
  }

  addSentryExpoConfigRequire(ast, metroConfigPath);

  return true;
}

export function addSentryExpoConfigRequire(
  program: t.Program,
  metroConfigPath: string,
) {
  try {
    const lastRequireIndex = getLastRequireIndex(program);
    const sentryExpoConfigRequire = createSentryExpoConfigRequire();

    // Add the require statement after the last require or at the beginning
    program.body.splice(lastRequireIndex + 1, 0, sentryExpoConfigRequire);
  } catch (error) {
    clack.log.error(
      `Could not add Sentry Expo config require statement to ${chalk.cyan(
        metroConfigPath,
      )}.`,
    );
    reportCliError(
      new Error(
        `Could not add Sentry Expo config require statement to ${metroConfigPath}.`,
      ),
    );
  }
}

/**
 * Creates const { getSentryExpoConfig } = require("@sentry/react-native/metro");
 */
function createSentryExpoConfigRequire() {
  return b.variableDeclaration("const", [
    b.variableDeclarator(
      b.objectPattern([
        b.objectProperty.from({
          key: b.identifier("getSentryExpoConfig"),
          value: b.identifier("getSentryExpoConfig"),
          shorthand: true,
        }),
      ]),
      b.callExpression(b.identifier("require"), [
        b.literal("@sentry/react-native/metro"),
      ]),
    ),
  ]);
}

async function createSentryExpoMetroConfig(
  metroConfigPath: string,
): Promise<boolean> {
  const snippet = `const { getSentryExpoConfig } = require("@sentry/react-native/metro");

const config = getSentryExpoConfig(__dirname);

module.exports = config;
`;
  try {
    await promises.writeFile(metroConfigPath, snippet);
  } catch (e) {
    clack.log.error(
      `Could not create ${chalk.cyan(
        metroConfigPath,
      )} with Sentry configuration.`,
    );
    reportCliError(
      new Error(
        `Could not create ${metroConfigPath} with Sentry configuration.`,
      ),
    );
    return false;
  }
  clack.log.success(
    `Created ${chalk.cyan(metroConfigPath)} with Sentry configuration.`,
  );
  return true;
}

function showInstructions(metroConfigPath: string) {
  return showCopyPasteInstructions({
    filename: metroConfigPath,
    codeSnippet: getMetroWithSentryExpoConfigSnippet(true),
  });
}

function getMetroWithSentryExpoConfigSnippet(colors: boolean): string {
  return makeCodeSnippet(colors, (unchanged, plus, minus) =>
    unchanged(`${minus(
      `// const { getDefaultConfig } = require("expo/metro-config");`,
    )}
${plus(
  `const { getSentryExpoConfig } = require("@sentry/react-native/metro");`,
)}

${minus(`// const config = getDefaultConfig(__dirname);`)}
${plus(`const config = getSentryExpoConfig(__dirname);`)}

module.exports = config;`),
  );
}
