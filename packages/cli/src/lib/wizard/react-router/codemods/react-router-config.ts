/**
 * Edits `react-router.config.(js|ts)`: turns on SSR and adds the
 * `sentryOnBuildEnd` hook that uploads source maps after a build.
 */

import type { namedTypes as t } from "ast-types";
import recast from "recast";
import path from "node:path";
import { existsSync, promises } from "node:fs";

import { parseModule, generateCode } from "magicast";

import { clack } from "../../utils/clack/prompts.js";
import chalk from "chalk";

import { preserveTrailingNewline } from "../../utils/ast-utils.js";
import { getSentryReactRouterVitePluginImportPath } from "../sdk-version.js";

/**
 * Extracts the ObjectExpression from various export patterns.
 * Supports: direct object, `satisfies Config`, and `as Config` patterns.
 */
function extractConfigObject(
  declaration: t.Declaration | t.Expression,
): t.ObjectExpression | undefined {
  if (declaration.type === "ObjectExpression") {
    return declaration as t.ObjectExpression;
  }

  if (
    declaration.type === "TSSatisfiesExpression" ||
    declaration.type === "TSAsExpression"
  ) {
    const expr = (declaration as t.TSSatisfiesExpression | t.TSAsExpression)
      .expression;
    return expr.type === "ObjectExpression" ? expr : undefined;
  }

  return undefined;
}

/**
 * Creates an identifier property for object literals.
 */
function createIdentifierProperty(name: string): t.Property {
  const b = recast.types.builders;
  return b.property("init", b.identifier(name), b.identifier(name));
}

export function addSentryBuildEndToReactRouterConfig(program: t.Program): {
  success: boolean;
  ssrWasChanged: boolean;
} {
  const b = recast.types.builders;
  let ssrWasChanged = false;

  const defaultExport = program.body.find(
    (node): node is t.ExportDefaultDeclaration =>
      node.type === "ExportDefaultDeclaration",
  );

  if (!defaultExport) {
    return { success: false, ssrWasChanged: false };
  }

  const configObj = extractConfigObject(defaultExport.declaration);

  if (!configObj) {
    return { success: false, ssrWasChanged: false };
  }

  if (findConfigProperty(configObj, "buildEnd")) {
    throw new Error(
      "A buildEnd hook already exists in your React Router config.",
    );
  }

  const ssrProp = findConfigProperty(configObj, "ssr");

  if (!ssrProp) {
    const ssrProperty = b.objectProperty(
      b.identifier("ssr"),
      b.booleanLiteral(true),
    );
    ssrProperty.comments = [
      b.commentLine(
        " SSR is required for Sentry sourcemap uploads to work correctly",
        true,
        false,
      ),
    ];
    configObj.properties.unshift(ssrProperty);
    ssrWasChanged = true;
  } else if (
    ssrProp.type === "ObjectProperty" &&
    (ssrProp.value.type === "BooleanLiteral" ||
      ssrProp.value.type === "Literal")
  ) {
    const wasExplicitlyFalse = ssrProp.value.value === false;

    if (wasExplicitlyFalse) {
      ssrWasChanged = true;
    }

    ssrProp.value = b.booleanLiteral(true);

    if (wasExplicitlyFalse) {
      ssrProp.comments = [
        b.commentLine(
          " Changed to true - SSR is required for Sentry sourcemap uploads",
          true,
          false,
        ),
      ];
    }
  }

  const paramNames = ["viteConfig", "reactRouterConfig", "buildManifest"];

  const buildEndFunction = b.arrowFunctionExpression(
    [b.objectPattern(paramNames.map(createIdentifierProperty))],
    b.blockStatement([
      b.expressionStatement(
        b.awaitExpression(
          b.callExpression(b.identifier("sentryOnBuildEnd"), [
            b.objectExpression(paramNames.map(createIdentifierProperty)),
          ]),
        ),
      ),
    ]),
  );
  buildEndFunction.async = true;

  configObj.properties.push(
    b.objectProperty(b.identifier("buildEnd"), buildEndFunction),
  );

  return { success: true, ssrWasChanged };
}

export function hasReactRouterSentryContent(program: t.Program): boolean {
  let hasSentry = false;

  recast.visit(program, {
    visitIdentifier(path) {
      if (path.node.name === "sentryOnBuildEnd") {
        hasSentry = true;
        return false; // stop traversal
      }
      this.traverse(path);
      return undefined;
    },
  });

  return hasSentry;
}

/**
 * The project's React Router config filename. Prefers an existing config with
 * either extension, so a `.js` config in a TypeScript project is updated
 * instead of shadowed by a new `.ts` file.
 */
export function getReactRouterConfigFilename(isTS: boolean): string {
  const preferred = `react-router.config.${isTS ? "ts" : "js"}`;
  const other = `react-router.config.${isTS ? "js" : "ts"}`;
  return (
    [preferred, other].find((candidate) =>
      existsSync(path.join(process.cwd(), candidate)),
    ) ?? preferred
  );
}

export async function instrumentReactRouterConfig(
  isTS: boolean,
  vitePluginImportPath: string = getSentryReactRouterVitePluginImportPath(
    undefined,
  ),
): Promise<{ ssrWasChanged: boolean }> {
  const configFilename = getReactRouterConfigFilename(isTS);
  const configPath = path.join(process.cwd(), configFilename);

  if (!existsSync(configPath)) {
    const defaultConfig = isTS
      ? `import type { Config } from "@react-router/dev/config";
import { sentryOnBuildEnd } from "${vitePluginImportPath}";

export default {
  ssr: true,
  buildEnd: async ({ viteConfig, reactRouterConfig, buildManifest }) => {
    await sentryOnBuildEnd({ viteConfig, reactRouterConfig, buildManifest });
  },
} satisfies Config;
`
      : `import { sentryOnBuildEnd } from "${vitePluginImportPath}";

export default {
  ssr: true,
  buildEnd: async ({ viteConfig, reactRouterConfig, buildManifest }) => {
    await sentryOnBuildEnd({ viteConfig, reactRouterConfig, buildManifest });
  },
};
`;
    await promises.writeFile(configPath, defaultConfig);
    return { ssrWasChanged: false };
  }

  const configContent = await promises.readFile(configPath, "utf-8");
  const filename = chalk.cyan(configFilename);

  const mod = parseModule(configContent);

  if (hasReactRouterSentryContent(mod.$ast as t.Program)) {
    clack.log.info(`${filename} already contains sentryOnBuildEnd.`);
    return { ssrWasChanged: false };
  }

  mod.imports.$add({
    from: vitePluginImportPath,
    imported: "sentryOnBuildEnd",
    local: "sentryOnBuildEnd",
  });

  const { success, ssrWasChanged } = addSentryBuildEndToReactRouterConfig(
    mod.$ast as t.Program,
  );

  if (!success) {
    throw new Error("Failed to modify React Router config structure");
  }

  const code = preserveTrailingNewline(
    configContent,
    generateCode(mod.$ast).code,
  );
  await promises.writeFile(configPath, code);

  return { ssrWasChanged };
}

/**
 * A config key, whether written `key`, `"key"` or as a method (`key() {}`), so
 * an existing entry is updated or detected instead of shadowed by a new one.
 */
function findConfigProperty(
  configObj: t.ObjectExpression,
  name: string,
): t.ObjectProperty | t.ObjectMethod | undefined {
  return configObj.properties.find(
    (p): p is t.ObjectProperty | t.ObjectMethod =>
      (p.type === "ObjectProperty" || p.type === "ObjectMethod") &&
      ((p.key.type === "Identifier" && p.key.name === name) ||
        (p.key.type === "StringLiteral" && p.key.value === name)),
  );
}
