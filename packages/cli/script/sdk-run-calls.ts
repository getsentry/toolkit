/**
 * Find `sdk.run(…)` calls in TypeScript example code.
 *
 * `run()` takes the same argv as the CLI, so literal calls can be checked
 * against the route tree like shell examples. Code is parsed with the
 * TypeScript compiler, so nested parentheses, template literals, comments,
 * and multi-line calls are handled the way TypeScript sees them.
 */

import ts from "typescript";
import { markdownCodeBlocks } from "./markdown.js";

/** Markdown fence languages parsed as TypeScript. */
export const TS_LANGS = new Set(["ts", "typescript", "js", "javascript"]);

/** Whether `node` is `sdk.run(…)` (the documented receiver name). */
function isSdkRun(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "run" &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "sdk"
  );
}

/**
 * Argv arrays of `sdk.run("issue", "list", …)` calls in a TypeScript
 * snippet. Calls with any non-literal argument (variables, spreads,
 * interpolated templates) are skipped because their argv isn't static.
 */
export function sdkRunCalls(code: string): string[][] {
  const source = ts.createSourceFile(
    "example.ts",
    code,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const calls: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isSdkRun(node)) {
      const args = node.arguments;
      if (args.every(ts.isStringLiteralLike)) {
        calls.push(args.map((arg) => arg.text));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

/** `@example` tag bodies of one standalone JSDoc comment. */
function exampleTagBodies(comment: string): string[] {
  // Attach the comment to a placeholder statement so the compiler parses it
  // as that statement's JSDoc.
  const source = ts.createSourceFile(
    "jsdoc.ts",
    `${comment}\nvoid 0;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statement = source.statements[0];
  if (!statement) {
    return [];
  }
  return ts
    .getJSDocTags(statement)
    .filter((tag) => tag.tagName.text === "example")
    .map((tag) => ts.getTextOfJSDocComment(tag.comment) ?? "");
}

/**
 * Code from every `@example` JSDoc tag in a TypeScript file. Fenced examples
 * yield their fenced code; unfenced examples yield the whole tag body.
 *
 * Every `/** … *\/` comment is visited, including stacked comments on one
 * node (the compiler's JSDoc helpers only report the closest one).
 */
export function jsdocExamples(fileName: string, text: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const seen = new Set<number>();
  const examples: string[] = [];
  const visit = (node: ts.Node): void => {
    for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
      const comment = text.slice(range.pos, range.end);
      if (seen.has(range.pos) || !comment.startsWith("/**")) {
        continue;
      }
      seen.add(range.pos);
      for (const body of exampleTagBodies(comment)) {
        const fenced = markdownTsBlocks(body);
        examples.push(...(fenced.length ? fenced : [body]));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return examples;
}

/** Code of the TypeScript/JavaScript fenced blocks of a Markdown document. */
export function markdownTsBlocks(markdown: string): string[] {
  return markdownCodeBlocks(markdown)
    .filter((block) => TS_LANGS.has(block.lang))
    .map((block) => block.code);
}
