#!/usr/bin/env tsx
/**
 * Check `sentry …` examples in hand-written docs against the live route tree.
 *
 * Every `sentry` invocation in a fenced shell block or inline code span, and
 * every structured command example (`docs.examples`, which feeds `--help` and
 * the generated command pages), must:
 *   1. Name a command that exists (e.g. `sentry upgrade` → `sentry cli upgrade`)
 *   2. Use only flags (and single-letter aliases) that command defines
 *   3. Not pass a bare org-looking slug (`my-org`) as a target. A bare name
 *      matches a project first, so examples that mean the org must use the
 *      trailing-slash form (`my-org/`)
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

import { mkdirSync, readdirSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Command,
  PositionalParam,
  RouteMap,
  RouteTarget,
} from "../src/lib/introspect.js";
import { blankCodeBlocks, markdownCodeBlocks } from "./markdown.js";
import { DOCS_CONTENT, DOCS_FRAGMENTS } from "./paths.js";

// Bootstrap: skill-content stub (same pattern as generate-docs-sections.ts)
const SKILL_CONTENT_PATH = "src/generated/skill-content.ts";
const skillContentExists = await access(SKILL_CONTENT_PATH).then(
  () => true,
  () => false,
);
if (!skillContentExists) {
  mkdirSync("src/generated", { recursive: true });
  await writeFile(
    SKILL_CONTENT_PATH,
    "export const SKILL_FILES: [string, string][] = [];\n",
  );
}

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
  "plugins/README.md",
];

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
const COMMAND_SPLIT_RE = /\s*(?:\|\||&&|\||;)\s*/;
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

/** Split a shell command into words, honoring single and double quotes. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let hasToken = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "#" && !hasToken) {
      break; // comment
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) {
    tokens.push(current);
  }
  return tokens;
}

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
      for (const segment of line.split(COMMAND_SPLIT_RE)) {
        if (segment.startsWith("sentry ")) {
          invocations.push(segment);
        }
      }
    }
  }
  const prose = blankCodeBlocks(markdown);
  for (const [, code = ""] of prose.matchAll(INLINE_CODE_RE)) {
    invocations.push(code);
  }
  return invocations;
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

/** Problems with one `sentry …` invocation. */
function checkInvocation(invocation: string): string[] {
  const words = tokenize(invocation);
  // Skip a `sudo` or `NAME=value` prefix, e.g. `SENTRY_DSN=… sentry monitor run`
  const start = words.findIndex(
    (word) => word !== "sudo" && !ENV_ASSIGNMENT_RE.test(word),
  );
  if (words[start] !== "sentry") {
    return [];
  }
  const tokens = words.slice(start + 1);
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
  return (target.__examples ?? []).map((e) => ({
    source,
    invocation: e.command,
  }));
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
for (const file of files) {
  const content = await readFile(file, "utf-8");
  for (const invocation of extractInvocations(content)) {
    checked += 1;
    for (const problem of checkInvocation(invocation)) {
      findings.push({ file, example: invocation, problem });
    }
  }
}

if (findings.length === 0) {
  console.log(
    `✓ ${checked} sentry examples in ${files.length} files match the CLI`,
  );
  process.exit(0);
}

console.error(`✗ ${findings.length} doc example problem(s):\n`);
for (const f of findings) {
  console.error(`  ${f.file}: ${f.example}`);
  console.error(`    → ${f.problem}\n`);
}
process.exit(1);
