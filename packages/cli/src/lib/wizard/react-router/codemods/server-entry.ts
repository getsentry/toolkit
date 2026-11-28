/**
 * Instruments a React Router `entry.server` file: wraps `handleRequest`,
 * captures errors in `handleError`, and exports the instrumentation API hooks.
 */

import type { ProxifiedModule } from "magicast";

import recast from "recast";
import type { namedTypes as t } from "ast-types";

import { clack } from "../../utils/clack/prompts.js";
import chalk from "chalk";

import { generateCode, loadFile, writeFile } from "magicast";
import { debug } from "../../utils/debug.js";
import {
  hasSentryContent,
  safeCalleeIdentifierMatch,
  safeGetIdentifierName,
} from "../../utils/ast-utils.js";
import { getAfterImportsInsertionIndex } from "./utils.js";

export async function instrumentServerEntry(
  serverEntryPath: string,
  useInstrumentationAPI = false,
): Promise<void> {
  const serverEntryAst = await loadFile(serverEntryPath);

  if (!hasSentryContent(serverEntryAst.$ast as t.Program)) {
    serverEntryAst.imports.$add({
      from: "@sentry/react-router",
      imported: "*",
      local: "Sentry",
    });
  }

  instrumentHandleError(serverEntryAst);
  instrumentHandleRequest(serverEntryAst);

  if (useInstrumentationAPI) {
    instrumentInstrumentations(serverEntryAst);
  }

  await writeFile(serverEntryAst.$ast, serverEntryPath);
}

function instrumentInstrumentations(
  originalEntryServerMod: ProxifiedModule,
): void {
  const originalEntryServerModAST = originalEntryServerMod.$ast as t.Program;

  const hasInstrumentations = originalEntryServerModAST.body.some((node) => {
    if (
      node.type !== "ExportNamedDeclaration" ||
      node.declaration?.type !== "VariableDeclaration"
    ) {
      return false;
    }

    const declarations = node.declaration.declarations;
    if (declarations.length === 0) {
      return false;
    }

    const firstDeclaration = declarations[0];
    if (firstDeclaration?.type !== "VariableDeclarator") {
      return false;
    }

    const id = firstDeclaration.id;
    return (
      id.type === "Identifier" &&
      (id.name === "instrumentations" ||
        id.name === "unstable_instrumentations")
    );
  });

  if (hasInstrumentations) {
    debug("instrumentations export already exists, skipping adding it again");
    return;
  }

  const instrumentationsExport = recast.parse(
    `export const instrumentations = [Sentry.createSentryServerInstrumentation()];`,
  ).program.body[0];

  originalEntryServerModAST.body.push(instrumentationsExport);
}

export function instrumentHandleRequest(
  originalEntryServerMod: ProxifiedModule,
): void {
  const originalEntryServerModAST = originalEntryServerMod.$ast as t.Program;

  const defaultServerEntryExport = originalEntryServerModAST.body.find(
    (node) => {
      return node.type === "ExportDefaultDeclaration";
    },
  );

  if (!defaultServerEntryExport) {
    clack.log.warn(
      `Could not find function ${chalk.cyan(
        "handleRequest",
      )} in your server entry file. Creating one for you.`,
    );

    let foundServerRouterImport = false as boolean;
    let foundRenderToPipeableStreamImport = false as boolean;
    let foundCreateReadableStreamFromReadableImport = false as boolean;

    for (const item of originalEntryServerMod.imports.$items) {
      if (item.imported === "ServerRouter" && item.from === "react-router") {
        foundServerRouterImport = true;
      }
      if (
        item.imported === "renderToPipeableStream" &&
        item.from === "react-dom/server"
      ) {
        foundRenderToPipeableStreamImport = true;
      }
      if (
        item.imported === "createReadableStreamFromReadable" &&
        item.from === "@react-router/node"
      ) {
        foundCreateReadableStreamFromReadableImport = true;
      }
    }

    if (!foundServerRouterImport) {
      originalEntryServerMod.imports.$add({
        from: "react-router",
        imported: "ServerRouter",
        local: "ServerRouter",
      });
    }

    if (!foundRenderToPipeableStreamImport) {
      originalEntryServerMod.imports.$add({
        from: "react-dom/server",
        imported: "renderToPipeableStream",
        local: "renderToPipeableStream",
      });
    }

    if (!foundCreateReadableStreamFromReadableImport) {
      originalEntryServerMod.imports.$add({
        from: "@react-router/node",
        imported: "createReadableStreamFromReadable",
        local: "createReadableStreamFromReadable",
      });
    }

    const implementation =
      recast.parse(`const handleRequest = Sentry.createSentryHandleRequest({
  ServerRouter,
  renderToPipeableStream,
  createReadableStreamFromReadable,
})`).program.body[0];

    try {
      originalEntryServerModAST.body.splice(
        getAfterImportsInsertionIndex(originalEntryServerModAST),
        0,
        implementation,
      );

      originalEntryServerModAST.body.push({
        type: "ExportDefaultDeclaration",
        declaration: {
          type: "Identifier",
          name: "handleRequest",
        },
      });
    } catch (error) {
      debug("Failed to insert handleRequest implementation:", error);
      throw new Error(
        "Could not automatically instrument handleRequest. Please add it manually.",
      );
    }
  } else if (
    // @ts-expect-error - StatementKind works here because the AST is proxified by magicast
    generateCode(defaultServerEntryExport).code.includes(
      "wrapSentryHandleRequest",
    )
  ) {
    debug("wrapSentryHandleRequest is already used, skipping wrapping again");
    clack.log.info(
      "Sentry handleRequest wrapper already detected, skipping instrumentation.",
    );
  } else {
    let defaultExportNode = null as t.ExportDefaultDeclaration | null;
    const defaultExportIndex = originalEntryServerModAST.body.findIndex(
      (node) => {
        const found = node.type === "ExportDefaultDeclaration";

        if (found) {
          defaultExportNode = node;
        }

        return found;
      },
    );

    if (defaultExportIndex !== -1 && defaultExportNode !== null) {
      recast.visit(defaultExportNode, {
        visitCallExpression(path) {
          if (
            safeCalleeIdentifierMatch(path.value.callee, "pipe") &&
            path.value.arguments.length &&
            path.value.arguments[0].type === "Identifier" &&
            safeGetIdentifierName(path.value.arguments[0]) === "body"
          ) {
            const wrapped = recast.types.builders.callExpression(
              recast.types.builders.memberExpression(
                recast.types.builders.identifier("Sentry"),
                recast.types.builders.identifier("getMetaTagTransformer"),
              ),
              [path.value.arguments[0]],
            );

            path.value.arguments[0] = wrapped;
          }

          this.traverse(path);
        },
      });

      // Replace the existing default export with the unwrapped function declaration
      const funcDeclaration = defaultExportNode.declaration;
      // Make non-async functions async so the return type matches wrapSentryHandleRequest
      if (
        funcDeclaration.type === "FunctionDeclaration" &&
        !funcDeclaration.async
      ) {
        funcDeclaration.async = true;
      }
      originalEntryServerModAST.body.splice(
        defaultExportIndex,
        1,
        // @ts-expect-error - an expression works here because the AST is proxified by magicast
        funcDeclaration,
      );

      // Adding our wrapped export
      originalEntryServerModAST.body.push(
        recast.types.builders.exportDefaultDeclaration(
          recast.types.builders.callExpression(
            recast.types.builders.memberExpression(
              recast.types.builders.identifier("Sentry"),
              recast.types.builders.identifier("wrapSentryHandleRequest"),
            ),
            [recast.types.builders.identifier("handleRequest")],
          ),
        ),
      );
    }
  }
}

export function instrumentHandleError(
  originalEntryServerMod: ProxifiedModule,
): void {
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
    originalEntryServerModAST.body.find((node) => {
      if (
        node.type !== "ExportNamedDeclaration" ||
        node.declaration?.type !== "VariableDeclaration"
      ) {
        return false;
      }

      const declarations = node.declaration.declarations;
      if (declarations.length === 0) {
        return false;
      }

      const firstDeclaration = declarations[0];
      if (firstDeclaration?.type !== "VariableDeclarator") {
        return false;
      }

      const id = firstDeclaration.id;
      return id.type === "Identifier" && id.name === "handleError";
    });

  if (
    !handleErrorFunctionExport &&
    !handleErrorFunctionVariableDeclarationExport
  ) {
    clack.log.warn(
      `Could not find function ${chalk.cyan(
        "handleError",
      )} in your server entry file. Creating one for you.`,
    );

    const implementation =
      recast.parse(`const handleError = Sentry.createSentryHandleError({
  logErrors: false
})`).program.body[0];

    originalEntryServerModAST.body.splice(
      getAfterImportsInsertionIndex(originalEntryServerModAST),
      0,
      recast.types.builders.exportNamedDeclaration(implementation),
    );
  } else if (
    (handleErrorFunctionExport &&
      // @ts-expect-error - StatementKind works here because the AST is proxified by magicast
      generateCode(handleErrorFunctionExport).code.includes(
        "captureException",
      )) ||
    (handleErrorFunctionVariableDeclarationExport &&
      // @ts-expect-error - StatementKind works here because the AST is proxified by magicast
      generateCode(handleErrorFunctionVariableDeclarationExport).code.includes(
        "captureException",
      ))
  ) {
    debug(
      "Found captureException inside handleError, skipping adding it again",
    );
  } else if (
    (handleErrorFunctionExport &&
      // @ts-expect-error - StatementKind works here because the AST is proxified by magicast
      generateCode(handleErrorFunctionExport).code.includes(
        "createSentryHandleError",
      )) ||
    (handleErrorFunctionVariableDeclarationExport &&
      // @ts-expect-error - StatementKind works here because the AST is proxified by magicast
      generateCode(handleErrorFunctionVariableDeclarationExport).code.includes(
        "createSentryHandleError",
      ))
  ) {
    debug("createSentryHandleError is already used, skipping adding it again");
  } else {
    const handleErrorFunction = getHandleErrorFunction(
      handleErrorFunctionExport ?? handleErrorFunctionVariableDeclarationExport,
    );
    const bindings =
      handleErrorFunction && bindErrorAndRequest(handleErrorFunction.params);
    if (!handleErrorFunction || !bindings) {
      debug(
        "Cannot safely access handleError function body or parameters, skipping instrumentation",
      );
      return;
    }

    const sentryCall = recast.parse(`if (!${bindings.request}.signal.aborted) {
  Sentry.captureException(${bindings.error});
}`).program.body[0];

    // Capture first, so an early return or rethrow in the existing handler
    // can't skip it.
    handleErrorFunction.body.body.unshift(sentryCall);
  }
}

type BlockBodiedFunction = (
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression
) & { body: t.BlockStatement };

/**
 * The function of an exported `handleError` declaration, when it is a
 * function declaration or a function/arrow expression with a block body.
 */
function getHandleErrorFunction(
  exportNode: t.Program["body"][number] | undefined,
): BlockBodiedFunction | undefined {
  if (exportNode?.type !== "ExportNamedDeclaration") {
    return undefined;
  }
  const declaration = exportNode.declaration;
  let fn: t.FunctionDeclaration | t.VariableDeclarator["init"] | undefined;
  if (declaration?.type === "FunctionDeclaration") {
    fn = declaration;
  } else if (declaration?.type === "VariableDeclaration") {
    const declarator = declaration.declarations[0];
    fn =
      declarator?.type === "VariableDeclarator" ? declarator.init : undefined;
  }
  if (
    (fn?.type === "FunctionDeclaration" ||
      fn?.type === "FunctionExpression" ||
      fn?.type === "ArrowFunctionExpression") &&
    fn.body.type === "BlockStatement"
  ) {
    return fn as BlockBodiedFunction;
  }
  return undefined;
}

/**
 * Make sure `handleError(error, { request })` binds the error and the
 * request, adding the missing parameters, and return the expressions that
 * reach them. `undefined` when an existing parameter has a shape we can't
 * extend safely.
 */
function bindErrorAndRequest(
  params: t.Function["params"],
): { error: string; request: string } | undefined {
  const b = recast.types.builders;
  const requestProperty = () => ({
    ...b.property("init", b.identifier("request"), b.identifier("request")),
    shorthand: true,
  });

  const [errorParam, contextParam] = params;
  if (!errorParam) {
    params.push(b.identifier("error"));
  } else if (errorParam.type !== "Identifier") {
    return undefined;
  }
  const error = errorParam?.type === "Identifier" ? errorParam.name : "error";

  if (!contextParam) {
    params.push(b.objectPattern([requestProperty()]));
    return { error, request: "request" };
  }
  // `{ request } = {}` binds like `{ request }`.
  const context =
    contextParam.type === "AssignmentPattern"
      ? contextParam.left
      : contextParam;
  if (context.type === "Identifier") {
    return { error, request: `${context.name}.request` };
  }
  if (context.type !== "ObjectPattern") {
    return undefined;
  }
  const existing = context.properties.find(
    (prop) => "key" in prop && safeGetIdentifierName(prop.key) === "request",
  );
  if (!existing) {
    // A property can't follow `...rest`, and `request` is already in it.
    const rest = context.properties.find(
      (prop) => prop.type === "RestElement" || prop.type === "RestProperty",
    );
    if (rest) {
      return "argument" in rest && rest.argument.type === "Identifier"
        ? { error, request: `${rest.argument.name}.request` }
        : undefined;
    }
    context.properties.push(requestProperty());
    return { error, request: "request" };
  }
  if (existing.type === "Property" || existing.type === "ObjectProperty") {
    // `{ request = fallback }` binds `request` too.
    const value =
      existing.value.type === "AssignmentPattern"
        ? existing.value.left
        : existing.value;
    if (value.type === "Identifier") {
      return { error, request: value.name };
    }
  }
  return undefined;
}
