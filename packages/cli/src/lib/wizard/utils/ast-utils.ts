/**
 * Helpers that find and change nodes in a recast AST, shared by the wizards
 * that edit JavaScript and TypeScript config files.
 */

import recast from "recast";

import { debug } from "./debug.js";
import type { namedTypes as t } from "ast-types";

const b = recast.types.builders;

/**
 * checks for require('@sentry/*') syntax
 */
export function hasSentryContent(program: t.Program): boolean {
  let foundSentry: boolean | undefined = false;
  recast.visit(program, {
    visitStringLiteral(path) {
      foundSentry = foundSentry || path.node.value.startsWith("@sentry/");
      this.traverse(path);
    },
    visitLiteral(path) {
      foundSentry =
        foundSentry || path.node.value?.toString().startsWith("@sentry/");
      this.traverse(path);
    },
  });

  return !!foundSentry;
}

/**
 * Searches for a property of an ObjectExpression by name
 *
 * @param object the ObjectExpression to search in
 * @param name the name of the property to search for
 *
 * @returns the property if it exists
 */
export function getObjectProperty(
  object: t.ObjectExpression,
  name: string,
): t.Property | undefined {
  return object.properties.find((p): p is t.Property => {
    const isObjectProp = p.type === "Property" || p.type === "ObjectProperty";

    if (!isObjectProp) {
      return false;
    }

    const hasMatchingLiteralKey =
      (p.key.type === "Literal" || p.key.type === "StringLiteral") &&
      p.key.value === name;

    if (hasMatchingLiteralKey) {
      return true;
    }

    // has matching identifier key
    return p.key.type === "Identifier" && p.key.name === name;
  });
}

/**
 * Attempts to find a property of an ObjectExpression by name. If it doesn't exist,
 * the property will be added to the ObjectExpression with the provided default value.
 *
 * @param object the parent object expression to search in
 * @param name the name of the property to search for
 * @param defaultValue the default value to set if the property doesn't exist
 *
 * @returns the
 */
export function getOrSetObjectProperty(
  object: t.ObjectExpression,
  name: string,
  defaultValue:
    | t.Literal
    | t.BooleanLiteral
    | t.StringLiteral
    | t.ObjectExpression,
): t.Property {
  const existingProperty = getObjectProperty(object, name);

  if (existingProperty) {
    return existingProperty;
  }

  const newProperty = b.property.from({
    kind: "init",
    key: b.stringLiteral(name),
    value: defaultValue,
  });

  object.properties.push(newProperty);

  return newProperty;
}

/**
 * Sets a property of an ObjectExpression if it exists, otherwise adds it
 * to the ObjectExpression. Optionally, a comment can be added to the
 * property.
 *
 * @param object the ObjectExpression to set the property on
 * @param name the name of the property to set
 * @param value  the value of the property to set
 * @param comment (optional) a comment to add to the property
 */
export function setOrUpdateObjectProperty(
  object: t.ObjectExpression,
  name: string,
  value:
    | t.Literal
    | t.BooleanLiteral
    | t.StringLiteral
    | t.ObjectExpression
    | t.ArrayExpression,
  comment?: string,
): void {
  const newComments = comment
    ?.split("\n")
    .map((c) => b.commentLine(` ${c}`, true, false));

  const existingProperty = getObjectProperty(object, name);

  if (existingProperty) {
    existingProperty.value = value;
    if (newComments) {
      existingProperty.comments = [
        ...(existingProperty.comments ?? []),
        ...newComments,
      ];
    }
  } else {
    object.properties.push(
      b.objectProperty.from({
        key: b.stringLiteral(name),
        value,
        ...(newComments && {
          comments: newComments,
        }),
      }),
    );
  }
}

type JsonCParseResult =
  | {
      jsonObject: t.ObjectExpression;
      ast: t.Program;
    }
  | {
      jsonObject: undefined;
      ast: undefined;
    };

/**
 * Parses a JSON string with (potential) comments (JSON-C) and returns the JS AST
 * that can be walked and modified with recast like a normal JS AST.
 *
 * This is done by wrapping the JSON-C string in parentheses, thereby making it
 * a JS `Program` with an `ExpressionStatement` as its body. The expression is then
 * extracted from the AST and returned alongside the AST.
 *
 * To preserve as much original formatting as possible, the returned `ast`
 * property should be passed to {@link `printJsonC`} to get the JSON-C string back.
 *
 * If the input is not valid JSON-C, the result will be undefined.
 *
 * @see {@link JsonCParseResult}
 *
 * @param jsonString a JSON-C string
 *
 * @returns a {@link JsonCParseResult}, containing either the JSON-C object and the AST or undefined in both cases
 */
export function parseJsonC(jsonString: string): JsonCParseResult {
  try {
    const jsTsConfig = `(${jsonString})`;
    // no idea why recast returns any here, this is dumb :/
    const ast = recast.parse(jsTsConfig.toString()).program as t.Program;

    const statement = ast.body[0];
    const jsonObject =
      statement?.type === "ExpressionStatement" &&
      statement.expression.type === "ObjectExpression"
        ? statement.expression
        : undefined;

    if (jsonObject) {
      return { jsonObject, ast };
    }
  } catch (error) {
    // Not valid JSON-C: the caller handles the undefined result.
    debug(error);
    return { jsonObject: undefined, ast: undefined };
  }
  return { jsonObject: undefined, ast: undefined };
}

/**
 * Takes the AST of a parsed JSON-C "program" and returns the JSON-C string without
 * any of the temporary JS wrapper code that was previously applied.
 *
 * Only use this in conjunction with {@link `parseJsonC`}
 *
 * @param ast the `ast` returned from {@link `parseJsonC`}
 *
 * @returns the JSON-C string
 */
export function printJsonC(ast: t.Program): string {
  const js = recast.print(ast).code;
  return js.substring(1, js.length - 1);
}

/**
 * Walks the program body and returns index of the last variable assignment initialized by require statement.
 * Only counts top level require statements.
 *
 * @returns index of the last `const foo = require('bar');` statement or -1 if none was found.
 */
export function getLastRequireIndex(program: t.Program): number {
  let lastRequireIdex = -1;
  for (const [i, s] of program.body.entries()) {
    const declaration =
      s.type === "VariableDeclaration" ? s.declarations[0] : undefined;
    if (
      declaration?.type === "VariableDeclarator" &&
      declaration.init?.type === "CallExpression" &&
      declaration.init.callee.type === "Identifier" &&
      declaration.init.callee.name === "require"
    ) {
      lastRequireIdex = i;
    }
  }
  return lastRequireIdex;
}

/**
 * Safely checks if a callee is an identifier with the given name
 * Prevents crashes when accessing callee.name on non-identifier nodes
 */
export function safeCalleeIdentifierMatch(
  callee: unknown,
  name: string,
): boolean {
  return Boolean(
    callee &&
    typeof callee === "object" &&
    "type" in callee &&
    (callee as { type: string }).type === "Identifier" &&
    "name" in callee &&
    (callee as { name: string }).name === name,
  );
}

/**
 * Safely gets the name of an identifier node
 * Returns null if the node is not an identifier or is undefined
 */
export function safeGetIdentifierName(node: unknown): string | null {
  return node &&
    typeof node === "object" &&
    "type" in node &&
    node.type === "Identifier" &&
    "name" in node
    ? String(node.name)
    : null;
}

/**
 * Safely access function body array with proper validation
 * Prevents crashes when accessing body.body on nodes that don't have a body
 */
export function safeGetFunctionBody(node: unknown): t.Statement[] | null {
  if (!node || typeof node !== "object" || !("body" in node)) {
    return null;
  }

  const nodeBody = node.body;
  if (!nodeBody || typeof nodeBody !== "object" || !("body" in nodeBody)) {
    return null;
  }

  const bodyArray = nodeBody.body;
  return Array.isArray(bodyArray) ? (bodyArray as t.Statement[]) : null;
}

/**
 * Safely insert statement before last statement in function body
 * Typically used to insert code before a return statement
 * Returns true if insertion was successful, false otherwise
 */
export function safeInsertBeforeReturn(
  body: t.Statement[],
  statement: t.Statement,
): boolean {
  if (body.length === 0) {
    return false;
  }

  // Insert before the last statement (typically a return statement)
  const insertIndex = Math.max(0, body.length - 1);
  body.splice(insertIndex, 0, statement);
  return true;
}

/**
 * Finds a property in an ObjectExpression by name.
 * Commonly used for traversing Vite/React Router config objects.
 *
 * @param configObj - The ObjectExpression to search
 * @param name - The property name to find
 * @returns The matching ObjectProperty, or undefined if not found
 */
export function findProperty(
  configObj: t.ObjectExpression,
  name: string,
): t.ObjectProperty | undefined {
  return configObj.properties.find(
    (p) =>
      p.type === "ObjectProperty" &&
      p.key.type === "Identifier" &&
      p.key.name === name,
  ) as t.ObjectProperty | undefined; // Safe: predicate guarantees type
}

/**
 * Preserves trailing newline from original content if present.
 * Code generators like magicast/recast don't preserve trailing newlines,
 * so this ensures we don't unnecessarily modify user files.
 *
 * @param originalContent - The original file content
 * @param generatedCode - The code generated by AST transformation
 * @returns The generated code with trailing newline preserved if original had one
 */
export function preserveTrailingNewline(
  originalContent: string,
  generatedCode: string,
): string {
  const hadTrailingNewline = originalContent.endsWith("\n");
  const hasTrailingNewline = generatedCode.endsWith("\n");

  if (hadTrailingNewline && !hasTrailingNewline) {
    return generatedCode + "\n";
  }

  return generatedCode;
}
