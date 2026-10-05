#!/usr/bin/env tsx
/**
 * Check for Error Class Misuse Patterns
 *
 * Scans source files for common anti-patterns in error class usage:
 *
 * 1. `new ContextError(resource, command)` where command contains `\n`
 *    → Should use ResolutionError for resolution failures
 *
 * 2. `new CliError(... "Try:" ...)` — ad-hoc "Try:" strings
 *    → Should use ResolutionError with structured hint/suggestions
 *
 * Silent catch blocks used to be checked here via a ratchet baseline. That
 * check now lives in the Biome plugin `lint-rules/no-silent-catch.grit`, whose
 * grandfathered backlog is pinned inline with `// biome-ignore lint/plugin`
 * comments (an unused suppression is itself reported, so the backlog can only
 * shrink). See #1531.
 *
 * Usage:
 *   tsx script/check-error-patterns.ts   # check (fails CI on any violation)
 *
 * Exit codes:
 *   0 - No anti-patterns found
 *   1 - Anti-patterns detected
 */

import { readFile } from "node:fs/promises";
import { glob } from "tinyglobby";

export type Violation = { file: string; line: number; message: string };

const CONTEXT_ERROR_RE = /new ContextError\(/g;
const TRY_PATTERN_RE = /["'`]Try:/;

/** Characters that open a nesting level in JavaScript source. */
function isOpener(ch: string): boolean {
  return ch === "(" || ch === "[" || ch === "{";
}

/** Characters that close a nesting level in JavaScript source. */
function isCloser(ch: string): boolean {
  return ch === ")" || ch === "]" || ch === "}";
}

/** Characters that start a string literal in JavaScript source. */
function isQuote(ch: string): boolean {
  return ch === '"' || ch === "'" || ch === "`";
}

/**
 * Skip past a `${...}` expression inside a template literal.
 * @param content - Full source text
 * @param start - Index right after the `{` in `${`
 * @returns Index right after the closing `}`
 */
function skipTemplateExpression(content: string, start: number): number {
  let braceDepth = 1;
  let i = start;
  while (i < content.length && braceDepth > 0) {
    const ec = content[i];
    if (ec === "\\") {
      i += 2;
    } else if (ec === "`") {
      i = skipTemplateLiteral(content, i + 1);
    } else if (ec === "{") {
      braceDepth += 1;
      i += 1;
    } else if (ec === "}") {
      braceDepth -= 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  return i;
}

/**
 * Skip past a template literal, handling nested `${...}` expressions.
 * @param content - Full source text
 * @param start - Index right after the opening backtick
 * @returns Index right after the closing backtick
 */
function skipTemplateLiteral(content: string, start: number): number {
  let i = start;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "\\") {
      i += 2;
    } else if (ch === "`") {
      return i + 1;
    } else if (ch === "$" && content[i + 1] === "{") {
      i = skipTemplateExpression(content, i + 2);
    } else {
      i += 1;
    }
  }
  return i;
}

/**
 * Advance past a string literal (single-quoted, double-quoted, or template).
 * @param content - Full source text
 * @param start - Index of the opening quote character
 * @returns Index right after the closing quote
 */
function skipString(content: string, start: number): number {
  const quote = content[start];
  if (quote === "`") {
    return skipTemplateLiteral(content, start + 1);
  }
  let i = start + 1;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "\\") {
      i += 2;
    } else if (ch === quote) {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return i;
}

/**
 * Advance one token in JS source, skipping strings as atomic units.
 * @returns The next index and the character at position `i` (or the string span's first char).
 */
function advanceToken(
  content: string,
  i: number
): { next: number; ch: string } {
  const ch = content[i] ?? "";
  if (isQuote(ch)) {
    return { next: skipString(content, i), ch };
  }
  return { next: i + 1, ch };
}

/**
 * Walk from `startIdx` (just inside the opening `(`) to find the matching `)`,
 * tracking commas at depth 1.
 * @returns The index of the first comma (between arg1 and arg2) and the closing paren index.
 */
function findCallBounds(
  content: string,
  startIdx: number
): { commaIdx: number; closingIdx: number } | null {
  let depth = 1;
  let commaCount = 0;
  let commaIdx = -1;
  let i = startIdx;

  while (i < content.length && depth > 0) {
    const { next, ch } = advanceToken(content, i);
    if (isOpener(ch)) {
      depth += 1;
    } else if (isCloser(ch)) {
      depth -= 1;
    } else if (ch === "," && depth === 1) {
      commaCount += 1;
      if (commaCount === 1) {
        commaIdx = i;
      }
    }
    i = next;
  }

  if (commaIdx === -1) {
    return null;
  }
  return { commaIdx, closingIdx: i - 1 };
}

/**
 * Extract the second argument of a `new ContextError(...)` call from source text.
 * Properly handles template literals so backticks don't break depth tracking.
 * @returns The raw source text of the second argument, or null if not found.
 */
function extractSecondArg(content: string, startIdx: number): string | null {
  const bounds = findCallBounds(content, startIdx);
  if (!bounds) {
    return null;
  }

  const { commaIdx, closingIdx } = bounds;

  // Find end of second arg: next comma at depth 1 or closing paren
  let endIdx = closingIdx;
  let d = 1;
  for (let j = commaIdx + 1; j < closingIdx; j += 1) {
    const { next, ch } = advanceToken(content, j);
    if (isOpener(ch)) {
      d += 1;
    } else if (isCloser(ch)) {
      d -= 1;
    } else if (ch === "," && d === 1) {
      endIdx = j;
      break;
    }
    // advanceToken may skip multiple chars (strings), adjust loop var
    j = next - 1; // -1 because for-loop increments
  }

  return content.slice(commaIdx + 1, endIdx).trim();
}

/**
 * Detect `new ContextError(` where the second argument contains `\n`.
 * This catches resolution-failure prose stuffed into the command parameter.
 */
export function findContextErrorNewlines(
  content: string,
  filePath: string
): Violation[] {
  const found: Violation[] = [];
  let match = CONTEXT_ERROR_RE.exec(content);
  while (match !== null) {
    const startIdx = match.index + match[0].length;
    const secondArg = extractSecondArg(content, startIdx);

    if (secondArg?.includes("\\n")) {
      const line = content.slice(0, match.index).split("\n").length;
      found.push({
        file: filePath,
        line,
        message:
          "ContextError command contains '\\n'. Use ResolutionError for multi-line resolution failures.",
      });
    }
    match = CONTEXT_ERROR_RE.exec(content);
  }
  return found;
}

/**
 * Detect `new CliError(... "Try:" ...)` — ad-hoc "Try:" strings that bypass
 * the structured ResolutionError pattern.
 */
export function findAdHocTryPatterns(
  content: string,
  filePath: string
): Violation[] {
  const found: Violation[] = [];
  const lines = content.split("\n");
  let inCliError = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.includes("new CliError(")) {
      inCliError = true;
    }
    if (inCliError && TRY_PATTERN_RE.test(line)) {
      found.push({
        file: filePath,
        line: i + 1,
        message:
          'CliError contains "Try:" — use ResolutionError with structured hint/suggestions instead.',
      });
      inCliError = false;
    }
    // Reset after a reasonable window (closing paren)
    if (inCliError && line.includes(");")) {
      inCliError = false;
    }
  }
  return found;
}

/** Scan the given files and collect violations. */
export async function scanFiles(files: string[]): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const filePath of files) {
    const content = await readFile(filePath, "utf-8");
    violations.push(...findContextErrorNewlines(content, filePath));
    violations.push(...findAdHocTryPatterns(content, filePath));
  }
  return violations;
}

async function main(): Promise<void> {
  const files = await glob("src/**/*.ts");
  const violations = await scanFiles(files);

  if (violations.length > 0) {
    console.error(
      `✗ Found ${violations.length} error class anti-pattern(s):\n`
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}`);
      console.error(`    ${v.message}\n`);
    }
    console.error(
      "Fix: Use ResolutionError for resolution failures, ValidationError for input errors."
    );
    console.error(
      "See ContextError JSDoc in src/lib/errors.ts for usage guidance.\n"
    );
    process.exit(1);
  }

  console.log("✓ No error class anti-patterns found.");
  process.exit(0);
}

// Only run when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
