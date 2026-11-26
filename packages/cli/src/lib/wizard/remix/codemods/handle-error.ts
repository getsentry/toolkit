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
  } else if (handleErrorFunctionExport) {
    const implementation = recast.parse(HANDLE_ERROR_TEMPLATE).program.body[0];

    // If the current handleError function has a body, we need to merge the new implementation with the existing one
    implementation.declarations[0].init.arguments[0].body.body.unshift(
      // @ts-expect-error - declaration works here because the AST is proxified by magicast
      ...handleErrorFunctionExport.declaration.body.body,
    );

    // @ts-expect-error - declaration works here because the AST is proxified by magicast
    handleErrorFunctionExport.declaration = implementation;
  } else if (handleErrorFunctionVariableDeclarationExport) {
    const implementation = recast.parse(HANDLE_ERROR_TEMPLATE).program.body[0];

    // If the current handleError function has a body, we need to merge the new implementation with the existing one
    implementation.declarations[0].init.arguments[0].body.body.unshift(
      // @ts-expect-error - declaration works here because the AST is proxified by magicast
      ...handleErrorFunctionVariableDeclarationExport.declaration
        .declarations[0].init.body.body,
    );

    // @ts-expect-error - declaration works here because the AST is proxified by magicast
    handleErrorFunctionVariableDeclarationExport.declaration = implementation;
  }

  return true;
}
