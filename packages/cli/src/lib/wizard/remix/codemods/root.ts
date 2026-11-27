/**
 * Wraps a Remix root route with `withSentry` and captures errors in its
 * `ErrorBoundary`.
 */

import recast from "recast";
import path from "node:path";

import type { namedTypes as t } from "ast-types";

import {
  builders,
  generateCode,
  loadFile,
  type ProxifiedModule,
  writeFile,
} from "magicast";

import { ERROR_BOUNDARY_TEMPLATE } from "../templates.js";
import { hasSentryContent } from "../utils.js";
import chalk from "chalk";

import { clack } from "../../utils/clack/prompts.js";

export function wrapAppWithSentry(
  rootRouteAst: ProxifiedModule,
  rootFileName: string,
) {
  rootRouteAst.imports.$add({
    from: "@sentry/remix",
    imported: "withSentry",
    local: "withSentry",
  });

  recast.visit(rootRouteAst.$ast, {
    visitExportDefaultDeclaration(path) {
      if (path.value.declaration.type === "FunctionDeclaration") {
        // Move the function declaration just before the default export
        path.insertBefore(path.value.declaration);

        // Get the name of the function to be wrapped
        const functionName: string = path.value.declaration.id.name as string;

        // Create the wrapped function call
        const functionCall = recast.types.builders.callExpression(
          recast.types.builders.identifier("withSentry"),
          [recast.types.builders.identifier(functionName)],
        );

        // Replace the default export with the wrapped function call
        path.value.declaration = functionCall;
      } else if (path.value.declaration.type === "Identifier") {
        const rootRouteExport = rootRouteAst.exports["default"];

        const expressionToWrap = generateCode(rootRouteExport.$ast).code;

        rootRouteAst.exports["default"] = builders.raw(
          `withSentry(${expressionToWrap})`,
        );
      } else {
        clack.log.warn(
          chalk.yellow(
            `Couldn't instrument ${chalk.bold(
              rootFileName,
            )} automatically. Wrap your default export with: ${chalk.dim(
              "withSentry()",
            )}\n`,
          ),
        );
      }

      this.traverse(path);
    },
  });
}

export function isWithSentryAlreadyUsed(
  rootRouteAst: ProxifiedModule,
): boolean {
  // Check if withSentry is called anywhere in the code
  let isUsed = false;
  recast.visit(rootRouteAst.$ast, {
    visitCallExpression(path) {
      if (
        path.value.callee.type === "Identifier" &&
        path.value.callee.name === "withSentry"
      ) {
        isUsed = true;
        return false; // Stop traversal
      }
      this.traverse(path);
      return undefined;
    },
  });
  return isUsed;
}

export async function instrumentRoot(rootFileName: string): Promise<void> {
  const rootRouteAst = await loadFile(
    path.join(process.cwd(), "app", rootFileName),
  );

  const exportsAst = rootRouteAst.exports.$ast as t.Program;

  const errorBoundaryName = findErrorBoundaryLocalName(exportsAst);
  const foundErrorBoundary = errorBoundaryName !== undefined;
  const withSentryAlreadyUsed = isWithSentryAlreadyUsed(rootRouteAst);

  if (!foundErrorBoundary) {
    rootRouteAst.imports.$add({
      from: "@sentry/remix",
      imported: "captureRemixErrorBoundaryError",
      local: "captureRemixErrorBoundaryError",
    });

    rootRouteAst.imports.$add({
      from: "@remix-run/react",
      imported: "useRouteError",
      local: "useRouteError",
    });

    // Call wrapAppWithSentry if withSentry is not already used
    if (!withSentryAlreadyUsed) {
      wrapAppWithSentry(rootRouteAst, rootFileName);
    }

    recast.visit(rootRouteAst.$ast, {
      visitExportDefaultDeclaration(path) {
        const implementation = recast.parse(ERROR_BOUNDARY_TEMPLATE).program
          .body[0];

        path.insertBefore(
          recast.types.builders.exportDeclaration(false, implementation),
        );

        this.traverse(path);
      },
    });
    // If there is already a ErrorBoundary export, and it doesn't have Sentry content
  } else if (!hasSentryContent(rootFileName, rootRouteAst.$code)) {
    rootRouteAst.imports.$add({
      from: "@sentry/remix",
      imported: "captureRemixErrorBoundaryError",
      local: "captureRemixErrorBoundaryError",
    });

    // Call wrapAppWithSentry if withSentry is not already used
    if (!withSentryAlreadyUsed) {
      wrapAppWithSentry(rootRouteAst, rootFileName);
    }

    const errorBoundaryFunction = errorBoundaryName
      ? findFunction(exportsAst, errorBoundaryName)
      : undefined;
    if (errorBoundaryFunction) {
      const usesRouteErrorHook = captureErrorInBoundary(errorBoundaryFunction);
      if (!usesRouteErrorHook) {
        rootRouteAst.imports.$add({
          from: "@remix-run/react",
          imported: "useRouteError",
          local: "useRouteError",
        });
      }
    } else {
      clack.log.warn(
        `Couldn't find the ${chalk.cyan("ErrorBoundary")} function in ${chalk.cyan(
          rootFileName,
        )}. Call ${chalk.cyan(
          "captureRemixErrorBoundaryError(useRouteError())",
        )} in it to report errors to Sentry.`,
      );
    }
  } else if (!withSentryAlreadyUsed) {
    // Even if we have Sentry content but withSentry is not used, we should still wrap the app
    wrapAppWithSentry(rootRouteAst, rootFileName);
  }

  await writeFile(
    rootRouteAst.$ast,
    path.join(process.cwd(), "app", rootFileName),
  );
}

type FunctionNode =
  | t.FunctionDeclaration
  | t.FunctionExpression
  | t.ArrowFunctionExpression;

/**
 * Local name of the root route's `ErrorBoundary` export, for
 * `export function ErrorBoundary`, `export const ErrorBoundary = ...` and
 * `export { Boundary as ErrorBoundary }`.
 */
function findErrorBoundaryLocalName(program: t.Program): string | undefined {
  for (const node of program.body) {
    if (node.type !== "ExportNamedDeclaration") {
      continue;
    }
    const declaration = node.declaration;
    if (
      declaration?.type === "FunctionDeclaration" &&
      declaration.id?.name === "ErrorBoundary"
    ) {
      return "ErrorBoundary";
    }
    if (
      declaration?.type === "VariableDeclaration" &&
      declaration.declarations.some(
        (d) =>
          d.type === "VariableDeclarator" &&
          d.id.type === "Identifier" &&
          d.id.name === "ErrorBoundary",
      )
    ) {
      return "ErrorBoundary";
    }
    if (!node.source) {
      for (const specifier of node.specifiers ?? []) {
        if (
          specifier.type === "ExportSpecifier" &&
          specifier.exported.name === "ErrorBoundary"
        ) {
          const local = specifier.local?.name;
          return typeof local === "string" ? local : "ErrorBoundary";
        }
      }
    }
  }
  return undefined;
}

/** The top-level function (declaration or `const` initializer) named `name`. */
function findFunction(
  program: t.Program,
  name: string,
): FunctionNode | undefined {
  for (const node of program.body) {
    const statement =
      node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (
      statement?.type === "FunctionDeclaration" &&
      statement.id?.name === name
    ) {
      return statement;
    }
    if (statement?.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) {
        if (
          declarator.type === "VariableDeclarator" &&
          declarator.id.type === "Identifier" &&
          declarator.id.name === name &&
          (declarator.init?.type === "ArrowFunctionExpression" ||
            declarator.init?.type === "FunctionExpression")
        ) {
          return declarator.init;
        }
      }
    }
  }
  return undefined;
}

/**
 * Report the boundary's error to Sentry right after it is read with
 * `useRouteError()`, reading it first when the boundary doesn't. Returns
 * whether the boundary already called `useRouteError`.
 */
function captureErrorInBoundary(fn: FunctionNode): boolean {
  const b = recast.types.builders;
  if (fn.body.type !== "BlockStatement") {
    fn.body = b.blockStatement([b.returnStatement(fn.body)]);
  }
  const statements = fn.body.body;

  const isRouteErrorRead = (
    d: t.VariableDeclaration["declarations"][number],
  ): d is t.VariableDeclarator =>
    d.type === "VariableDeclarator" &&
    d.id.type === "Identifier" &&
    isUseRouteErrorCall(d.init);
  const hookIndex = statements.findIndex(
    (statement) =>
      statement.type === "VariableDeclaration" &&
      statement.declarations.some(isRouteErrorRead),
  );
  const hookStatement = statements[hookIndex];
  const hookDeclarator =
    hookStatement?.type === "VariableDeclaration"
      ? hookStatement.declarations.find(isRouteErrorRead)
      : undefined;
  const errorName =
    hookDeclarator?.id.type === "Identifier"
      ? hookDeclarator.id.name
      : undefined;

  const capture = (name: string) =>
    b.expressionStatement(
      b.callExpression(b.identifier("captureRemixErrorBoundaryError"), [
        b.identifier(name),
      ]),
    );

  if (errorName) {
    statements.splice(hookIndex + 1, 0, capture(errorName));
    return true;
  }
  statements.unshift(
    b.variableDeclaration("const", [
      b.variableDeclarator(
        b.identifier("error"),
        b.callExpression(b.identifier("useRouteError"), []),
      ),
    ]),
    capture("error"),
  );
  return false;
}

/**
 * `useRouteError()`, also behind TypeScript wrappers such as
 * `useRouteError() as Error` or `useRouteError()!`.
 */
function isUseRouteErrorCall(node: unknown): boolean {
  let expression = node as { type?: string; expression?: unknown } | null;
  while (
    expression &&
    (expression.type === "TSAsExpression" ||
      expression.type === "TSSatisfiesExpression" ||
      expression.type === "TSNonNullExpression" ||
      expression.type === "TSTypeAssertion" ||
      expression.type === "ParenthesizedExpression")
  ) {
    expression = expression.expression as typeof expression;
  }
  const call = expression as t.CallExpression | null;
  return (
    call?.type === "CallExpression" &&
    call.callee.type === "Identifier" &&
    call.callee.name === "useRouteError"
  );
}
