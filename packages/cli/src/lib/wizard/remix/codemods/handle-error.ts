/**
 * Adds or wraps `handleError` in a Remix `entry.server` file so server
 * errors reach Sentry.
 */

import type { ProxifiedModule } from "magicast";
import type { namedTypes as t } from "ast-types";

import recast from "recast";

import { HANDLE_ERROR_TEMPLATE } from "../templates.js";
import { getAfterImportsInsertionIndex, hasSentryContent } from "../utils.js";

import { clack } from "../../utils/clack/prompts.js";
import chalk from "chalk";

export function instrumentHandleError(
  originalEntryServerMod: ProxifiedModule,
  serverEntryFilename: string,
): boolean {
  const originalEntryServerModAST = originalEntryServerMod.$ast as t.Program;

  const handleErrorFunctionExport = originalEntryServerModAST.body.find(
    (node) => {
      return (
        node.type === "ExportNamedDeclaration" &&
        node.declaration?.type === "FunctionDeclaration" &&
        node.declaration.id?.name === "handleError"
      );
    },
  );

  const handleErrorFunctionVariableDeclarationExport =
    originalEntryServerModAST.body.find(
      (node) =>
        node.type === "ExportNamedDeclaration" &&
        node.declaration?.type === "VariableDeclaration" &&
        // @ts-expect-error - id should always have a name in this case
        node.declaration.declarations[0].id.name === "handleError",
    );

  if (
    !handleErrorFunctionExport &&
    !handleErrorFunctionVariableDeclarationExport
  ) {
    clack.log.warn(
      `Could not find function ${chalk.cyan("handleError")} in ${chalk.cyan(
        serverEntryFilename,
      )}. Creating one for you.`,
    );

    const implementation = recast.parse(HANDLE_ERROR_TEMPLATE).program.body[0];

    originalEntryServerModAST.body.splice(
      getAfterImportsInsertionIndex(originalEntryServerModAST),
      0,
      recast.types.builders.exportNamedDeclaration(implementation),
    );
  } else if (
    (handleErrorFunctionExport &&
      ["wrapHandleErrorWithSentry", "sentryHandleError"].some((util) =>
        hasSentryContent(
          recast.print(handleErrorFunctionExport).code,
          originalEntryServerMod.$code,
          util,
        ),
      )) ||
    (handleErrorFunctionVariableDeclarationExport &&
      ["wrapHandleErrorWithSentry", "sentryHandleError"].some((util) =>
        hasSentryContent(
          recast.print(handleErrorFunctionVariableDeclarationExport).code,
          originalEntryServerMod.$code,
          util,
        ),
      ))
  ) {
    return false;
  } else if (
    handleErrorFunctionExport?.type === "ExportNamedDeclaration" &&
    handleErrorFunctionExport.declaration?.type === "FunctionDeclaration"
  ) {
    // Wrap the whole function, so `async`, its parameters and its body stay
    // as they are.
    const fn = handleErrorFunctionExport.declaration;
    const b = recast.types.builders;
    const functionExpression = b.functionExpression(
      null,
      fn.params,
      fn.body,
      fn.generator,
    );
    functionExpression.async = fn.async ?? false;
    handleErrorFunctionExport.declaration = b.variableDeclaration("const", [
      b.variableDeclarator(
        b.identifier("handleError"),
        wrapWithSentry(functionExpression),
      ),
    ]);
  } else if (
    handleErrorFunctionVariableDeclarationExport?.type ===
      "ExportNamedDeclaration" &&
    handleErrorFunctionVariableDeclarationExport.declaration?.type ===
      "VariableDeclaration"
  ) {
    const declarator =
      handleErrorFunctionVariableDeclarationExport.declaration.declarations[0];
    if (declarator?.type !== "VariableDeclarator" || !declarator.init) {
      return false;
    }
    // Any initializer works: an arrow or function expression, or a handler
    // built elsewhere.
    declarator.init = wrapWithSentry(declarator.init);
  }

  return true;
}

/** `Sentry.wrapHandleErrorWithSentry(<handler>)` */
function wrapWithSentry(
  handler: Parameters<typeof recast.types.builders.callExpression>[1][number],
): ReturnType<typeof recast.types.builders.callExpression> {
  const b = recast.types.builders;
  return b.callExpression(
    b.memberExpression(
      b.identifier("Sentry"),
      b.identifier("wrapHandleErrorWithSentry"),
    ),
    [handler],
  );
}
