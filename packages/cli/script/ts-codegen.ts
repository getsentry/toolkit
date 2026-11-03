/**
 * Small helpers for emitting TypeScript through the compiler's own AST factory.
 *
 * Generators that interpolate values into source strings have to remember to escape
 * every one of them. Building nodes instead lets the printer handle quoting, string
 * escaping, and indentation, so a command brief containing `*` + `/` or an enum value
 * containing a quote cannot produce a broken file.
 */

import ts from "typescript";

/** Shorthand for the compiler's node factory. */
export const f = ts.factory;

/** Closing sequence of a block comment; it must never appear verbatim inside one. */
const COMMENT_CLOSE_RE = /\*\//g;

/** Line breaks inside comment text; each continuation line needs a leading `*`. */
const NEWLINE_RE = /\r?\n/g;

/** A property key: a bare identifier when valid, otherwise a quoted string literal. */
export function propertyName(name: string): ts.PropertyName {
  return ts.isIdentifierText(name, ts.ScriptTarget.ESNext)
    ? f.createIdentifier(name)
    : f.createStringLiteral(name);
}

/** `object?.name`, or `object?.["name"]` when `name` is not a valid identifier. */
export function optionalAccess(object: string, name: string): ts.Expression {
  const target = f.createIdentifier(object);
  const questionDot = f.createToken(ts.SyntaxKind.QuestionDotToken);
  return ts.isIdentifierText(name, ts.ScriptTarget.ESNext)
    ? f.createPropertyAccessChain(target, questionDot, name)
    : f.createElementAccessChain(
        target,
        questionDot,
        f.createStringLiteral(name),
      );
}

/** `object.name`, or `object["name"]` when `name` is not a valid identifier. */
export function access(object: string, name: string): ts.Expression {
  const target = f.createIdentifier(object);
  return ts.isIdentifierText(name, ts.ScriptTarget.ESNext)
    ? f.createPropertyAccessExpression(target, name)
    : f.createElementAccessExpression(target, f.createStringLiteral(name));
}

/** A reference to a named type, optionally with type arguments (`Promise<T>`). */
export function typeRef(name: string, args?: ts.TypeNode[]): ts.TypeNode {
  return f.createTypeReferenceNode(name, args);
}

/** A union of string literal types (`"a" | "b"`). */
export function stringLiteralUnion(values: readonly string[]): ts.TypeNode {
  return f.createUnionTypeNode(
    values.map((value) =>
      f.createLiteralTypeNode(f.createStringLiteral(value)),
    ),
  );
}

/** Escape text so it can sit inside a `/** ... *\/` block without terminating it early. */
function escapeJsDoc(text: string): string {
  return text.replace(COMMENT_CLOSE_RE, "*\\/").replace(NEWLINE_RE, "\n * ");
}

/** Attach a single-paragraph JSDoc comment to `node`; a no-op when `text` is empty. */
export function withJsDoc<T extends ts.Node>(node: T, text?: string): T {
  if (!text) {
    return node;
  }
  return ts.addSyntheticLeadingComment(
    node,
    ts.SyntaxKind.MultiLineCommentTrivia,
    `* ${escapeJsDoc(text)} `,
    true,
  );
}

/** Print top-level nodes as TypeScript source, separated by blank lines. */
export function printNodes(nodes: readonly ts.Node[]): string {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const file = ts.createSourceFile(
    "generated.ts",
    "",
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.TS,
  );
  return nodes
    .map((node) => printer.printNode(ts.EmitHint.Unspecified, node, file))
    .join("\n\n");
}
