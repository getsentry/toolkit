#!/usr/bin/env tsx

/**
 * Check for Stale Toolchain References
 *
 * Scans dev-facing documentation and scripts for references to package
 * managers or runtimes that are no longer used by this project. The check
 * is generic: it reads `packageManager` from package.json to determine
 * the current PM, then flags any dev-facing file that references a
 * a different PM's commands (e.g., `bun run`, `yarn remove`).
 *
 * If the project migrates from pnpm to another PM, simply updating the
 * `packageManager` field in package.json will automatically make this
 * check flag every `pnpm run` / `pnpm add` reference in dev docs.
 *
 * Usage:
 *   tsx script/check-stale-references.ts
 *
 * Exit codes:
 *   0 - No stale references found
 *   1 - Stale references detected
 */

import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DOCS_CONTENT } from "./paths.js";

const pkg = JSON.parse(await readFile("package.json", "utf-8"));
const currentPM: string = (pkg.packageManager ?? "").split("@")[0];

if (!currentPM) {
  console.error("✗ Cannot determine package manager from package.json");
  process.exit(1);
}

/** All known JS package managers whose dev commands should not appear when another PM is active. */
const ALL_PACKAGE_MANAGERS = ["bun", "yarn", "pnpm", "npm"];

const stalePMs = ALL_PACKAGE_MANAGERS.filter((pm) => pm !== currentPM);

if (stalePMs.length === 0) {
  console.log("✓ No stale package manager patterns to check");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Patterns (derived dynamically from the non-current package managers)
// ---------------------------------------------------------------------------

const escaped = stalePMs.join("|");

type StalePattern = {
  pattern: RegExp;
  reason: string;
};

const PATTERNS: StalePattern[] = [
  {
    // "bun run", "yarn remove", "bun add -d", etc. (dev commands)
    pattern: new RegExp(`\\b(?:${escaped})\\s+(?:run|remove|add\\s+-[dD])\\b`),
    reason: `Use '${currentPM}' commands instead`,
  },
  {
    // "requires Bun", "Yarn installed", "Bun runtime" (prerequisite prose)
    pattern: new RegExp(
      `\\b(?:requires\\s+(?:${escaped})|(?:${escaped})\\s+(?:installed|runtime))\\b`,
      "i"
    ),
    reason: `Project uses ${currentPM}, not these runtimes`,
  },
];

// ---------------------------------------------------------------------------
// Files to scan (curated — dev-facing docs and scripts only)
// ---------------------------------------------------------------------------

/** Dev-facing doc files that should not reference stale PMs. */
const DOC_FILES = [
  "DEVELOPMENT.md",
  "plugins/README.md",
  `${DOCS_CONTENT}/contributing.md`,
  `${DOCS_CONTENT}/library-usage.md`,
];

/** This script's own filename — excluded from scanning to avoid self-flagging. */
const SELF = "script/check-stale-references.ts";

/** Script files whose error messages / JSDoc should not reference stale PMs. */
function getScriptFiles(): string[] {
  try {
    return readdirSync("script")
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `script/${f}`)
      .filter((f) => f !== SELF);
  } catch {
    return [];
  }
}

const FILES_TO_SCAN = [...DOC_FILES, ...getScriptFiles()];

// ---------------------------------------------------------------------------
// Code block stripping (avoid false positives on user install examples)
// ---------------------------------------------------------------------------

const FENCED_CODE_BLOCK_RE = /^(`{3,}|~{3,}).*\n[\s\S]*?\n\1\s*$/gm;

/** Strip fenced code blocks from markdown content to avoid false positives. */
function stripCodeBlocks(content: string): string {
  return content.replace(FENCED_CODE_BLOCK_RE, "");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Finding = {
  file: string;
  line: number;
  text: string;
  reason: string;
};

const findings: Finding[] = [];

for (const filePath of FILES_TO_SCAN) {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist — skip silently (e.g., optional doc files)
    continue;
  }

  // For markdown files, strip code blocks to avoid matching user install examples
  const isMarkdown = filePath.endsWith(".md") || filePath.endsWith(".mdx");
  const scannable = isMarkdown ? stripCodeBlocks(content) : content;

  const lines = scannable.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { pattern, reason } of PATTERNS) {
      if (pattern.test(line)) {
        // Find the original line number in the un-stripped content
        // For scripts (no stripping), i is the actual line number
        const originalLine = isMarkdown
          ? findOriginalLineNumber(content, line)
          : i + 1;
        findings.push({
          file: filePath,
          line: originalLine,
          text: line.trim(),
          reason,
        });
      }
    }
  }
}

/**
 * Find the 1-indexed line number of a text line in the original content.
 * Falls back to 0 if not found (shouldn't happen in practice).
 */
function findOriginalLineNumber(
  original: string,
  strippedLine: string
): number {
  const trimmed = strippedLine.trim();
  const lines = original.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === trimmed) {
      return i + 1;
    }
  }
  return 0;
}

if (findings.length === 0) {
  console.log(
    `✓ No stale package manager references found (current: ${currentPM}, checked: ${FILES_TO_SCAN.length} files)`
  );
  process.exit(0);
}

console.error(
  `✗ Found ${findings.length} stale package manager reference(s) (current PM: ${currentPM}):\n`
);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}: ${f.text}`);
  console.error(`    → ${f.reason}\n`);
}
process.exit(1);
