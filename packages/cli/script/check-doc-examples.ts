#!/usr/bin/env tsx
/**
 * Check `sentry …` examples in hand-written docs against the live route tree.
 *
 * Every `sentry` invocation in a fenced shell block or inline code span, and
 * every step of every structured command example (`docs.examples`, which
 * feeds `--help` and the generated command pages), must:
 *   1. Name a command that exists (e.g. `sentry upgrade` → `sentry cli upgrade`)
 *   2. Use only flags (and single-letter aliases) that command defines
 *   3. Not pass a bare org-looking slug (`my-org`) as a target. A bare name
 *      matches a project first, so examples that mean the org must use the
 *      trailing-slash form (`my-org/`)
 *
 * Hints built with the `` sentry`…` `` tag (src/lib/app-identity.ts) get the
 * same checks, with each interpolation read as a placeholder.
 *
 * Library examples that pass only string literals to `sdk.run(…)` get the same
 * checks, since `run()` takes the same argv as the CLI. Those calls are found
 * by parsing TypeScript fences and `@example` JSDoc with the TypeScript
 * compiler (see sdk-run-calls.ts), not by pattern matching.
 *
 * Placeholders (`<org>/<project>`, `[args]`, `...`) are skipped. Generated
 * command pages are not scanned: their examples are checked at the source.
 *
 * Usage:
 *   tsx script/check-doc-examples.ts
 *
 * Exit codes:
 *   0 - All examples are valid
 *   1 - At least one example names a missing command, flag, or ambiguous target
 */

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { exampleSteps } from "../src/lib/command-example.js";
import type {
  Command,
  PositionalParam,
  RouteMap,
  RouteTarget,
} from "../src/lib/introspect.js";
import { writeRouteTreeStubs } from "./lib/route-tree-stubs.js";
import { blankCodeBlocks, markdownCodeBlocks } from "./markdown.js";
import { DOCS_CONTENT, DOCS_FRAGMENTS } from "./paths.js";
import {
  jsdocExamples,
  markdownTsBlocks,
  sdkRunCalls,
} from "./sdk-run-calls.js";
import { shellCommands } from "./shell-words.js";
import { logger } from "../src/lib/logger.js";

await writeRouteTreeStubs();

const { routes } = await import("../src/app.js");
const { isCommand, isRouteMap } = await import("../src/lib/introspect.js");
const { getCompletionTarget, ORG_PROJECT_TARGET } =
  await import("../src/lib/completion-target.js");

/** Generated from the route tree, so not worth re-checking. */
const GENERATED_DOCS_DIR = `${DOCS_CONTENT}/commands`;

/** Hand-written Markdown outside the docs site that shows CLI usage. */
const EXTRA_DOC_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "DEVELOPMENT.md",
  "init.md",
  "plugins/README.md",
];

/** Source files whose JSDoc shows `sdk.run(…)` examples. */
const SDK_EXAMPLE_FILES = ["src/index.ts"];

/** Source scanned for `` sentry`…` `` hints. */
const SOURCE_DIR = "src";

/** Flags Stricli handles before command dispatch. */
const BUILTIN_FLAGS = new Set(["help", "help-all", "version"]);
const BUILTIN_ALIASES = new Set(["h", "H"]);

/**
 * Slugs that docs use for an organization. As a bare target they resolve to
 * a project first, so an example meaning "the org" needs `my-org/`.
 */
const ORG_PLACEHOLDER_RE = /^(?:my-org|acme)$/;

/** Placeholders of positionals parsed with `parseOrgProjectArg()`. */
const TARGET_PLACEHOLDER_RE = /^(?:target|org\/.+)$/;

const SHELL_LANGS = new Set(["", "bash", "sh", "shell", "zsh", "console"]);
const INLINE_CODE_RE = /(?<!`)`(sentry [^`\n]+)`(?!`)/g;
const PROMPT_RE = /^\$\s+/;
const CONTINUATION_RE = /\\\n\s*/g;
const PLACEHOLDER_RE = /[<>[\]{}]|\.\.\.|…|^\$/;
const SHORT_ALIAS_RE = /^-([a-zA-Z])$/;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

type Finding = { file: string; example: string; problem: string };

/** Stricli's alias-aware lookup, not part of the simplified RouteMap type. */
type RoutingMap = RouteMap & {
  getRoutingTargetForInput(input: string): RouteTarget | undefined;
};

/** Collect `sentry …` invocations from one Markdown file. */
function extractInvocations(markdown: string): string[] {
  const invocations: string[] = [];
  for (const { code, lang } of markdownCodeBlocks(markdown)) {
    if (!SHELL_LANGS.has(lang)) {
      continue;
    }
    for (const rawLine of code.replace(CONTINUATION_RE, " ").split("\n")) {
      const line = rawLine.trim().replace(PROMPT_RE, "");
      if (line.startsWith("#")) {
        continue;
      }
      if (shellCommands(line).some((words) => sentryArgs(words))) {
        invocations.push(line);
      }
    }
  }
  const prose = blankCodeBlocks(markdown);
  for (const [, code = ""] of prose.matchAll(INLINE_CODE_RE)) {
    invocations.push(code);
  }
  return invocations;
}

/** TypeScript example snippets: fenced blocks in Markdown, `@example` JSDoc in source. */
function typescriptExamples(file: string, content: string): string[] {
  return file.endsWith(".ts")
    ? jsdocExamples(file, content)
    : markdownTsBlocks(content);
}

/** Whether `--name` (or the boolean negation `--no-name`) is accepted. */
function hasFlag(cmd: Command, name: string): boolean {
  const flags = cmd.parameters.flags ?? {};
  const negated = name.startsWith("no-") ? name.slice(3) : undefined;
  return (
    BUILTIN_FLAGS.has(name) ||
    Object.hasOwn(flags, name) ||
    (negated !== undefined && Object.hasOwn(flags, negated))
  );
}

/** Walk the route tree; returns the command and the remaining tokens. */
function resolve(
  tokens: string[],
): { cmd: Command; rest: string[] } | { error: string } | null {
  let target: RouteTarget = routes as unknown as RouteMap;
  let i = 0;
  while (isRouteMap(target)) {
    const word = tokens[i];
    if (word === undefined || word.startsWith("-")) {
      const fallback = target.getDefaultCommand?.();
      if (fallback && isCommand(fallback)) {
        return { cmd: fallback, rest: tokens.slice(i) };
      }
      // `sentry issue` alone names a group; `--help` on a group is fine.
      return word === undefined || word === "--help" || word === "-h"
        ? null
        : { error: `\`${tokens.slice(0, i).join(" ")}\` is a group` };
    }
    if (PLACEHOLDER_RE.test(word)) {
      return null;
    }
    // Resolves aliases too (`issue ignore` → `issue archive`, `new` → `create`)
    const next = (target as RoutingMap).getRoutingTargetForInput(word);
    if (!next) {
      const fallback = target.getDefaultCommand?.();
      if (i > 0 && fallback && isCommand(fallback)) {
        return { cmd: fallback, rest: tokens.slice(i) };
      }
      const path = ["sentry", ...tokens.slice(0, i + 1)].join(" ");
      return { error: `unknown command \`${path}\`` };
    }
    target = next;
    i += 1;
  }
  return isCommand(target) ? { cmd: target, rest: tokens.slice(i) } : null;
}

/**
 * Whether a positional takes an `<org>/<project>` target, where a bare name
 * is a project search. Raw org slugs (placeholder `org`) are not targets.
 */
function isTargetParam(param: PositionalParam | undefined): boolean {
  if (!param) {
    return false;
  }
  return (
    getCompletionTarget(param.parse) === ORG_PROJECT_TARGET ||
    TARGET_PLACEHOLDER_RE.test(param.placeholder ?? "")
  );
}

/**
 * Arguments after `sentry` when `words` runs the CLI, skipping a `sudo` or
 * `NAME=value` prefix (e.g. `SENTRY_DSN=… sentry monitor run`).
 */
function sentryArgs(words: string[]): string[] | undefined {
  const start = words.findIndex(
    (word) => word !== "sudo" && !ENV_ASSIGNMENT_RE.test(word),
  );
  return words[start] === "sentry" ? words.slice(start + 1) : undefined;
}

/** Problems with the `sentry …` commands of one shell line. */
function checkInvocation(line: string): string[] {
  return shellCommands(line).flatMap(checkWords);
}

/** Problems with one tokenized command; other programs are ignored. */
function checkWords(words: string[]): string[] {
  const tokens = sentryArgs(words);
  if (!tokens) {
    return [];
  }
  const resolved = resolve(tokens);
  if (!resolved) {
    return [];
  }
  if ("error" in resolved) {
    return [resolved.error];
  }
  const { cmd, rest } = resolved;
  const problems: string[] = [];
  const aliases = cmd.parameters.aliases ?? {};
  const positionals: string[] = [];
  for (const token of rest) {
    if (token === "--") {
      break;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2).split("=")[0] ?? "";
      if (!(PLACEHOLDER_RE.test(name) || hasFlag(cmd, name))) {
        problems.push(`unknown flag \`--${name}\``);
      }
      continue;
    }
    const alias = token.match(SHORT_ALIAS_RE)?.[1];
    if (alias) {
      if (!(BUILTIN_ALIASES.has(alias) || Object.hasOwn(aliases, alias))) {
        problems.push(`unknown flag \`-${alias}\``);
      }
      continue;
    }
    positionals.push(token);
  }

  const firstParam =
    cmd.parameters.positional?.kind === "tuple"
      ? cmd.parameters.positional.parameters[0]
      : cmd.parameters.positional?.parameter;
  const first = positionals[0];
  if (first && ORG_PLACEHOLDER_RE.test(first) && isTargetParam(firstParam)) {
    problems.push(
      `bare \`${first}\` resolves to a project first; use \`${first}/\` for the organization`,
    );
  }
  return problems;
}

/**
 * Commands built with the `` sentry`…` `` tag in one source file, as
 * `sentry …` lines with each interpolation as an `<arg>` placeholder.
 */
function sentryTagCommands(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest);
  const commands: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === "sentry"
    ) {
      const { template } = node;
      const text = ts.isNoSubstitutionTemplateLiteral(template)
        ? template.text
        : template.head.text +
          template.templateSpans
            .map((span) => `<arg>${span.literal.text}`)
            .join("");
      commands.push(`sentry ${text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return commands;
}

function listSource(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => join(dir, f));
}

function listMarkdown(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf-8" })
    .filter((f) => f.endsWith(".md") || f.endsWith(".mdx"))
    .map((f) => join(dir, f))
    .filter((f) => !f.startsWith(GENERATED_DOCS_DIR));
}

const files = [
  ...listMarkdown(DOCS_CONTENT),
  ...listMarkdown(DOCS_FRAGMENTS),
  ...EXTRA_DOC_FILES,
];

/**
 * Structured command examples (`docs.examples`). These feed `--help` and the
 * generated command pages. Examples hand-written into `fullDescription` are
 * not checked; they belong in `docs.examples`.
 */
function commandExamples(
  target: RouteTarget,
  path: string[],
): { source: string; invocation: string }[] {
  if (isRouteMap(target)) {
    return target
      .getAllEntries()
      .filter((e) => !e.hidden) // hidden entries are plural aliases
      .flatMap((e) => commandExamples(e.target, [...path, e.name.original]));
  }
  if (!isCommand(target)) {
    return [];
  }
  const source = `\`${["sentry", ...path].join(" ")}\` help`;
  return (target.__examples ?? []).flatMap((e) =>
    exampleSteps(e, "sentry").map((invocation) => ({ source, invocation })),
  );
}

const findings: Finding[] = [];
let checked = 0;
for (const { source, invocation } of commandExamples(
  routes as unknown as RouteMap,
  [],
)) {
  checked += 1;
  for (const problem of checkInvocation(invocation)) {
    findings.push({ file: source, example: invocation, problem });
  }
}
for (const file of [...files, ...SDK_EXAMPLE_FILES]) {
  const content = await readFile(file, "utf-8");
  const invocations = file.endsWith(".ts") ? [] : extractInvocations(content);
  for (const invocation of invocations) {
    checked += 1;
    for (const problem of checkInvocation(invocation)) {
      findings.push({ file, example: invocation, problem });
    }
  }
  for (const argv of typescriptExamples(file, content).flatMap(sdkRunCalls)) {
    checked += 1;
    const example = `sdk.run(${argv.map((a) => JSON.stringify(a)).join(", ")})`;
    for (const problem of checkWords(["sentry", ...argv])) {
      findings.push({ file, example, problem });
    }
  }
}

const sourceFiles = listSource(SOURCE_DIR);
for (const file of sourceFiles) {
  const content = await readFile(file, "utf-8");
  if (!content.includes("sentry`")) {
    continue;
  }
  for (const invocation of sentryTagCommands(file, content)) {
    checked += 1;
    for (const problem of checkInvocation(invocation)) {
      findings.push({ file, example: invocation, problem });
    }
  }
}

if (findings.length === 0) {
  logger.success(
    `${checked} sentry examples in ${files.length + SDK_EXAMPLE_FILES.length + sourceFiles.length} files match the CLI`,
  );
  process.exit(0);
}

logger.error(
  [
    `${findings.length} doc example problem(s):\n`,
    ...findings.map((f) => `  ${f.file}: ${f.example}\n    → ${f.problem}\n`),
  ].join("\n"),
);
process.exit(1);
