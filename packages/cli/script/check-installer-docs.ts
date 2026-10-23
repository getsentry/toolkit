#!/usr/bin/env tsx
/**
 * Installer documentation coverage.
 *
 * The install scripts (`install` for bash, `install.ps1` for PowerShell) read
 * environment variables and flags that the CLI's ENV_VAR_REGISTRY never sees,
 * so check-env-coverage.ts cannot catch them. This check closes that gap:
 *
 *   1. Every `SENTRY_*` variable an installer reads, and every flag the bash
 *      installer parses, appears in that installer's own help text.
 *   2. Every variable and flag in either installer's help text appears in the
 *      installation guide (getting-started.mdx).
 *
 * Usage:
 *   tsx script/check-installer-docs.ts
 *
 * Exit codes:
 *   0 - Installer options are documented
 *   1 - An option is missing from installer help or the installation guide
 */

import { readFile } from "node:fs/promises";
import { DOCS_CONTENT } from "./paths.js";

const GUIDE = `${DOCS_CONTENT}/getting-started.mdx`;

/** `${SENTRY_FOO:-}` / `$SENTRY_FOO` reads in bash. */
const BASH_ENV_READ_RE = /\$\{?(SENTRY_[A-Z0-9_]+)/g;
/** `SENTRY_FOO="..."` script-local assignments (constants, not inputs). */
const BASH_ASSIGN_RE = /^\s*(?:local\s+)?(SENTRY_[A-Z0-9_]+)=/gm;
/** `--flag)` or `-f|--flag)` case arms in the bash argument parser. */
const BASH_FLAG_ARM_RE = /^\s*(?:-[a-z]\|)?(--[a-z][a-z-]*)\)/gm;
/** The `usage()` heredoc body in the bash installer. */
const BASH_USAGE_RE = /usage\(\) \{\n\s*cat <<EOF\n([\s\S]*?)\nEOF/;
/** `$env:SENTRY_FOO` reads in PowerShell. */
const PS_ENV_READ_RE = /\$env:(SENTRY_[A-Z0-9_]+)/g;
/** The leading `<# ... #>` comment-based help block in PowerShell. */
const PS_HELP_RE = /^<#([\s\S]*?)#>/;
/** Variable names listed in a help block. */
const HELP_VAR_RE = /\b(SENTRY_[A-Z0-9_]+)\b/g;

/** Flags handled by every CLI; not worth documenting in the guide. */
const UNDOCUMENTED_FLAGS = new Set(["--help"]);

type Installer = {
  file: string;
  reads: Set<string>;
  flags: Set<string>;
  help: string;
};

function matchAll(re: RegExp, text: string): Set<string> {
  return new Set([...text.matchAll(re)].map((m) => m[1] ?? ""));
}

async function loadBash(): Promise<Installer> {
  const file = "install";
  const source = await readFile(file, "utf-8");
  const help = source.match(BASH_USAGE_RE)?.[1];
  if (!help) {
    throw new Error(`${file}: usage() heredoc not found`);
  }
  const assigned = matchAll(BASH_ASSIGN_RE, source);
  const reads = new Set(
    [...matchAll(BASH_ENV_READ_RE, source)].filter((v) => !assigned.has(v)),
  );
  return { file, reads, flags: matchAll(BASH_FLAG_ARM_RE, source), help };
}

async function loadPowerShell(): Promise<Installer> {
  const file = "install.ps1";
  const source = await readFile(file, "utf-8");
  const help = source.match(PS_HELP_RE)?.[1];
  if (!help) {
    throw new Error(`${file}: <# ... #> help block not found`);
  }
  return {
    file,
    reads: matchAll(PS_ENV_READ_RE, source),
    flags: new Set(),
    help,
  };
}

const installers = [await loadBash(), await loadPowerShell()];
const guide = await readFile(GUIDE, "utf-8");
const problems: string[] = [];

for (const { file, reads, flags, help } of installers) {
  for (const name of [...reads, ...flags]) {
    if (!(UNDOCUMENTED_FLAGS.has(name) || help.includes(name))) {
      problems.push(`${file} reads ${name} but its help text omits it`);
    }
  }
  const documented = [...matchAll(HELP_VAR_RE, help), ...flags];
  for (const name of documented) {
    if (!(UNDOCUMENTED_FLAGS.has(name) || guide.includes(name))) {
      problems.push(`${file} supports ${name} but ${GUIDE} omits it`);
    }
  }
}

if (problems.length === 0) {
  console.log(
    `✓ Installer options are documented (${installers.map((i) => i.file).join(", ")})`,
  );
  process.exit(0);
}

console.error(`✗ ${problems.length} undocumented installer option(s):\n`);
for (const problem of problems) {
  console.error(`  ${problem}`);
}
process.exit(1);
