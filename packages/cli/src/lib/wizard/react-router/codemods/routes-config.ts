/**
 * Adds the example page and API routes to a React Router `routes.ts`.
 */

import recast from "recast";
import { existsSync } from "node:fs";
import type { namedTypes as t } from "ast-types";

import { loadFile, writeFile } from "magicast";

export async function addRoutesToConfig(
  routesConfigPath: string,
  isTS: boolean,
): Promise<void> {
  // Check if file exists first
  if (!existsSync(routesConfigPath)) {
    return;
  }

  const routesAst = await loadFile(routesConfigPath);

  // Check if routes are already added
  const routesCode = routesAst.$code;
  if (
    routesCode.includes("sentry-example-page") &&
    routesCode.includes("sentry-example-api")
  ) {
    return;
  }

  // Add route import if not already present
  const hasRouteImport = routesAst.imports.$items.some(
    (item) =>
      item.imported === "route" && item.from === "@react-router/dev/routes",
  );

  if (!hasRouteImport) {
    routesAst.imports.$add({
      from: "@react-router/dev/routes",
      imported: "route",
      local: "route",
    });
  }

  // Set up the new routes
  const routeExtension = isTS ? "tsx" : "jsx";
  const apiExtension = isTS ? "ts" : "js";

  const pageRouteCode = `route("/sentry-example-page", "routes/sentry-example-page.${routeExtension}")`;
  const apiRouteCode = `route("/api/sentry-example-api", "routes/api.sentry-example-api.${apiExtension}")`;

  let foundDefaultExport = false;

  // Get the AST program
  const program = routesAst.$ast as t.Program;

  // Find the default export
  for (let i = 0; i < program.body.length; i++) {
    const node = program.body[i];
    if (!node) {
      continue;
    }

    if (node.type === "ExportDefaultDeclaration") {
      foundDefaultExport = true;

      const declaration = node.declaration;

      let arrayExpression = null;

      if (declaration.type === "ArrayExpression") {
        arrayExpression = declaration;
      } else if (
        declaration.type === "TSSatisfiesExpression" ||
        declaration.type === "TSAsExpression"
      ) {
        // Handle `[...] satisfies RouteConfig` and `[...] as RouteConfig`
        if (declaration.expression.type === "ArrayExpression") {
          arrayExpression = declaration.expression;
        }
      }

      if (!arrayExpression) {
        // The caller turns this into manual instructions for the user.
        throw new Error(
          "The default export of the routes config is not an array literal",
        );
      }

      // Parse and add the new route calls directly to the elements array
      const pageRouteCall =
        recast.parse(pageRouteCode).program.body[0].expression;
      const apiRouteCall =
        recast.parse(apiRouteCode).program.body[0].expression;

      arrayExpression.elements.push(pageRouteCall);
      arrayExpression.elements.push(apiRouteCall);
      break;
    }
  }

  // If no default export found, add one
  if (!foundDefaultExport) {
    // Create a simple array export without satisfies for now
    const newExportCode = `export default [
  ${pageRouteCode},
  ${apiRouteCode},
];`;

    const newExport = recast.parse(newExportCode).program.body[0];
    program.body.push(newExport);
  }

  await writeFile(routesAst.$ast, routesConfigPath);
}
