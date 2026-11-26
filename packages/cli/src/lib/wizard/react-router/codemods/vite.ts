/**
 * Adds the Sentry React Router Vite plugin to `vite.config.(js|ts)`.
 */

import type { namedTypes as t } from "ast-types";
import recast from "recast";
import path from "node:path";
import { existsSync, promises } from "node:fs";

import { parseModule, generateCode } from "magicast";

import { clack } from "../../utils/clack/prompts.js";
import chalk from "chalk";

import {
  hasSentryContent,
  findProperty,
  preserveTrailingNewline,
} from "../../utils/ast-utils.js";
import { debug } from "../../utils/debug.js";
import { getSentryReactRouterVitePluginImportPath } from "../sdk-version.js";

/**
 * Extracts ObjectExpression from function body.
 * Handles both arrow functions with object returns and block statements with explicit returns.
 *
 * - Arrow with object-return: (config) => ({ ... })
 * - Arrow with block: (config) => { return { ... }; }
 * - Function with block: function(config) { return { ... }; }
 *
 * @param body - The function body to extract from
 * @returns The ObjectExpression if found, undefined otherwise
 */
function extractFromFunctionBody(
  body: t.Expression | t.BlockStatement,
): t.ObjectExpression | undefined {
  if (body.type === "ObjectExpression") {
    return body as t.ObjectExpression;
  }

  if (body.type === "BlockStatement") {
    const blockBody = body as t.BlockStatement;
    const returnStatement = blockBody.body.find(
      (stmt: t.Statement): stmt is t.ReturnStatement =>
        stmt.type === "ReturnStatement",
    );

    return returnStatement?.argument?.type === "ObjectExpression"
      ? returnStatement.argument
      : undefined;
  }

  return undefined;
}

/**
 * Creates the sentryReactRouter Vite plugin call expression.
 *
 * Generates AST for:
 * sentryReactRouter({
 *   org: "...",
 *   project: "...",
 *   authToken: process.env.SENTRY_AUTH_TOKEN
 * }, config)
 *
 * @param orgSlug - Sentry organization slug
 * @param projectSlug - Sentry project slug
 * @returns CallExpression node for the Sentry Vite plugin
 */
function createSentryPluginCall(
  orgSlug: string,
  projectSlug: string,
): t.CallExpression {
  const b = recast.types.builders;
  return b.callExpression(b.identifier("sentryReactRouter"), [
    b.objectExpression([
      b.objectProperty(b.identifier("org"), b.stringLiteral(orgSlug)),
      b.objectProperty(b.identifier("project"), b.stringLiteral(projectSlug)),
      b.objectProperty(
        b.identifier("authToken"),
        b.memberExpression(
          b.memberExpression(b.identifier("process"), b.identifier("env")),
          b.identifier("SENTRY_AUTH_TOKEN"),
        ),
      ),
    ]),
    b.identifier("config"),
  ]);
}

/** Adds @sentry/react-router to optimizeDeps.exclude to prevent 504 errors during dev. */
function addOptimizeDepsExclude(configObj: t.ObjectExpression): void {
  const b = recast.types.builders;

  const optimizeDeps = findProperty(configObj, "optimizeDeps");
  const optimizeDepsObj =
    optimizeDeps?.type === "ObjectProperty" &&
    optimizeDeps.value.type === "ObjectExpression"
      ? optimizeDeps.value
      : null;

  let targetDepsObj: t.ObjectExpression;
  if (!optimizeDepsObj) {
    if (optimizeDeps) {
      debug("optimizeDeps is not a static object, skipping exclude");
      return;
    }
    targetDepsObj = b.objectExpression([]);
    configObj.properties.push(
      b.objectProperty(b.identifier("optimizeDeps"), targetDepsObj),
    );
  } else {
    targetDepsObj = optimizeDepsObj;
  }

  const excludeProp = findProperty(targetDepsObj, "exclude");
  const excludeArr =
    excludeProp?.type === "ObjectProperty" &&
    excludeProp.value.type === "ArrayExpression"
      ? excludeProp.value
      : null;

  let targetArr: t.ArrayExpression;
  if (!excludeArr) {
    if (excludeProp) {
      debug("optimizeDeps.exclude is not a static array, skipping");
      return;
    }
    targetArr = b.arrayExpression([]);
    targetDepsObj.properties.push(
      b.objectProperty(b.identifier("exclude"), targetArr),
    );
  } else {
    targetArr = excludeArr;
  }

  const isAlreadyExcluded = targetArr.elements.some(
    (el) => el?.type === "StringLiteral" && el.value === "@sentry/react-router",
  );
  if (!isAlreadyExcluded) {
    targetArr.elements.push(b.stringLiteral("@sentry/react-router"));
  }
}

export function addReactRouterPluginToViteConfig(
  program: t.Program,
  orgSlug: string,
  projectSlug: string,
): { success: boolean; wasConverted: boolean } {
  const b = recast.types.builders;
  let wasConverted = false;

  const defaultExport = program.body.find(
    (node): node is t.ExportDefaultDeclaration =>
      node.type === "ExportDefaultDeclaration",
  );

  if (!defaultExport) {
    return { success: false, wasConverted: false };
  }

  let configObj: t.ObjectExpression | undefined;
  let defineConfigCall: t.CallExpression | undefined;

  if (
    defaultExport.declaration.type === "CallExpression" &&
    defaultExport.declaration.callee.type === "Identifier" &&
    defaultExport.declaration.callee.name === "defineConfig"
  ) {
    defineConfigCall = defaultExport.declaration;

    const arg = defineConfigCall.arguments[0];

    // Early exit if not single argument
    if (defineConfigCall.arguments.length !== 1 || !arg) {
      return { success: false, wasConverted: false };
    }

    if (arg.type === "ObjectExpression") {
      configObj = arg;
      // Convert to function form
      const arrowFunction = b.arrowFunctionExpression(
        [b.identifier("config")],
        configObj,
      );
      defineConfigCall.arguments[0] = arrowFunction;
      wasConverted = true;
    } else if (
      arg.type === "ArrowFunctionExpression" ||
      arg.type === "FunctionExpression"
    ) {
      configObj = extractFromFunctionBody(arg.body);
    }
  }

  if (!configObj) {
    return { success: false, wasConverted };
  }

  const pluginsProp = findProperty(configObj, "plugins");
  const sentryPluginCall = createSentryPluginCall(orgSlug, projectSlug);

  if (!pluginsProp) {
    configObj.properties.push(
      b.objectProperty(
        b.identifier("plugins"),
        b.arrayExpression([sentryPluginCall]),
      ),
    );
  } else if (pluginsProp.value.type === "ArrayExpression") {
    pluginsProp.value.elements.push(sentryPluginCall);
  } else {
    return { success: false, wasConverted };
  }

  // Prevent 504 "Outdated Optimize Dep" errors in dev (https://github.com/vitejs/vite/issues/13506)
  addOptimizeDepsExclude(configObj);

  return { success: true, wasConverted };
}

export async function instrumentViteConfig(
  orgSlug: string,
  projectSlug: string,
  vitePluginImportPath: string = getSentryReactRouterVitePluginImportPath(
    undefined,
  ),
): Promise<{ wasConverted: boolean }> {
  const configPath = existsSync(path.join(process.cwd(), "vite.config.ts"))
    ? path.join(process.cwd(), "vite.config.ts")
    : path.join(process.cwd(), "vite.config.js");

  if (!existsSync(configPath)) {
    throw new Error("Could not find vite.config.ts or vite.config.js");
  }

  const configContent = await promises.readFile(configPath, "utf-8");
  const filename = chalk.cyan(path.basename(configPath));

  const mod = parseModule(configContent);

  if (hasSentryContent(mod.$ast as t.Program)) {
    clack.log.info(`${filename} already contains sentryReactRouter plugin.`);
    return { wasConverted: false };
  }

  mod.imports.$add({
    from: vitePluginImportPath,
    imported: "sentryReactRouter",
    local: "sentryReactRouter",
  });

  const { success, wasConverted } = addReactRouterPluginToViteConfig(
    mod.$ast as t.Program,
    orgSlug,
    projectSlug,
  );

  if (!success) {
    throw new Error("Failed to modify Vite config structure");
  }

  const code = preserveTrailingNewline(
    configContent,
    generateCode(mod.$ast).code,
  );
  await promises.writeFile(configPath, code);

  return { wasConverted };
}
