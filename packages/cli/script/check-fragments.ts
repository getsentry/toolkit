#!/usr/bin/env tsx
/**
 * Validate doc fragment files.
 *
 * Ensures fragment files stay consistent with the CLI route tree:
 *   1. Every route has a corresponding fragment file (+ index.md)
 *   2. Every fragment file corresponds to an existing route (or is index.md)
 *   3. Fragment files don't accidentally contain frontmatter or the generated marker
 *   4. Top-level fragments (e.g., configuration.md) exist
 *   5. Fragment content covers all subcommands in a route (warnings only)
 *
 * Usage:
 *   tsx script/check-fragments.ts            # Warnings for missing subcommands
 *   tsx script/check-fragments.ts --strict   # Errors for missing subcommands
 */

import { mkdirSync, readdirSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import type { RouteInfo, RouteMap } from "../src/lib/introspect.js";
import { DOCS_FRAGMENTS } from "./paths.js";

// Ensure skill-content stub exists (see generate-command-docs.ts for rationale)
const SKILL_CONTENT_PATH = "src/generated/skill-content.ts";
const skillContentExists = await access(SKILL_CONTENT_PATH).then(
  () => true,
  () => false
);
if (!skillContentExists) {
  mkdirSync("src/generated", { recursive: true });
  await writeFile(
    SKILL_CONTENT_PATH,
    "export const SKILL_FILES: [string, string][] = [];\n"
  );
}

const { routes } = await import("../src/app.js");
const { extractAllRoutes } = await import("../src/lib/introspect.js");

const FRAGMENTS_DIR = `${DOCS_FRAGMENTS}/commands`;
const GENERATED_END_MARKER = "<!-- GENERATED:END -->";

/** Routes that don't have doc pages (and therefore no fragments) */
const SKIP_ROUTES = new Set(["help"]);

const MD_EXTENSION_RE = /\.md$/;

const isStrict = process.argv.includes("--strict");

const routeMap = routes as unknown as RouteMap;
const allRoutes = extractAllRoutes(routeMap).filter(
  (r) => !SKIP_ROUTES.has(r.name)
);
const routeNames = new Set(allRoutes.map((r) => r.name));

// Expected fragment files: one per route + index
const expectedFragments = new Set([...routeNames, "index"]);

let fragmentFiles: string[];
try {
  fragmentFiles = readdirSync(FRAGMENTS_DIR).filter((f) =>
    MD_EXTENSION_RE.test(f)
  );
} catch {
  console.error(`ERROR: Fragment directory not found: ${FRAGMENTS_DIR}`);
  process.exit(1);
}

const actualFragments = new Set(
  fragmentFiles.map((f) => f.replace(MD_EXTENSION_RE, ""))
);

const errors: string[] = [];

// Check 1: Every route has a fragment
for (const name of expectedFragments) {
  if (!actualFragments.has(name)) {
    errors.push(
      `Missing fragment: ${FRAGMENTS_DIR}/${name}.md (route "${name}" exists but has no fragment file)`
    );
  }
}

// Check 2: Every fragment corresponds to a route
for (const name of actualFragments) {
  if (!expectedFragments.has(name)) {
    errors.push(
      `Stale fragment: ${FRAGMENTS_DIR}/${name}.md (no matching route found — delete it or add the route)`
    );
  }
}

// Check 3: Fragment content validation
for (const file of fragmentFiles) {
  const content = await readFile(`${FRAGMENTS_DIR}/${file}`, "utf-8");

  if (content.includes("---\ntitle:") || content.startsWith("---\n")) {
    errors.push(
      `Fragment contains frontmatter: ${FRAGMENTS_DIR}/${file} (fragments should only contain custom content, not YAML frontmatter)`
    );
  }

  if (content.includes(GENERATED_END_MARKER)) {
    errors.push(
      `Fragment contains generated marker: ${FRAGMENTS_DIR}/${file} (the "${GENERATED_END_MARKER}" marker should not appear in fragment files)`
    );
  }
}

// ---------------------------------------------------------------------------
// Check 4: Top-level fragments (non-command generated pages)
// ---------------------------------------------------------------------------

const TOP_LEVEL_FRAGMENTS_DIR = DOCS_FRAGMENTS;

/** Top-level fragment files that must exist (for generated doc pages) */
const REQUIRED_TOP_LEVEL_FRAGMENTS = ["configuration"];

for (const name of REQUIRED_TOP_LEVEL_FRAGMENTS) {
  const path = `${TOP_LEVEL_FRAGMENTS_DIR}/${name}.md`;
  const exists = await access(path).then(
    () => true,
    () => false
  );
  if (!exists) {
    errors.push(
      `Missing top-level fragment: ${path} (required for generated ${name}.md page)`
    );
  }
}

// ---------------------------------------------------------------------------
// Check 5: Subcommand coverage in fragment content
// ---------------------------------------------------------------------------

const warnings: string[] = [];

const FENCED_CODE_BLOCK_RE = /^(`{3,}|~{3,}).*\n[\s\S]*?\n\1\s*$/gm;

/** Strip fenced code blocks from markdown to avoid matching bash comments as headings. */
function stripCodeBlocks(md: string): string {
  return md.replace(FENCED_CODE_BLOCK_RE, "");
}

/**
 * Check whether a fragment mentions a specific subcommand.
 *
 * Looks for either:
 *   1. A full CLI reference: `sentry <route> <subcommand>` anywhere in the text
 *   2. A markdown heading containing the leaf subcommand name (outside code blocks)
 *
 * For default commands (e.g., `sentry local serve` where `serve` is the
 * default), also accepts `sentry <route>` without the subcommand — since
 * users invoke the default command that way.
 */
function fragmentMentionsSubcommand(
  content: string,
  routeName: string,
  command: { path: string },
  isDefaultCommand: boolean
): boolean {
  // Extract the subcommand portion after "sentry <route>"
  const subPath = command.path.slice(`sentry ${routeName} `.length);
  const leaf = subPath.split(" ").at(-1) ?? subPath;
  const fullCliRef = command.path; // e.g. "sentry dashboard revisions"

  const lower = content.toLowerCase();

  // Check 1: Full CLI reference anywhere (code blocks, backticks, prose)
  if (lower.includes(fullCliRef.toLowerCase())) {
    return true;
  }

  // Check 2: For default commands, bare `sentry <route>` (not followed by a subcommand) counts.
  // Use a regex with word boundary to avoid matching `sentry issue events` as `sentry issue`.
  if (isDefaultCommand) {
    const bareRouteRe = new RegExp(
      `sentry\\s+${routeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*$|[^\\w-])`,
      "im"
    );
    if (bareRouteRe.test(lower)) {
      return true;
    }
  }

  // Check 3: Heading that mentions the leaf name (outside code blocks)
  const proseOnly = stripCodeBlocks(content);
  const escapedLeaf = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(`^#{1,4}\\s+.*\\b${escapedLeaf}\\b`, "im");
  if (headingRe.test(proseOnly)) {
    return true;
  }

  return false;
}

/**
 * Build a map of route name → RouteInfo for routes with multiple subcommands.
 * Standalone commands (single command matching `sentry <name>`) are skipped
 * since there's nothing to check — the fragment covers the whole command.
 */
function getMultiCommandRoutes(): Map<string, RouteInfo> {
  const result = new Map<string, RouteInfo>();
  for (const route of allRoutes) {
    // Skip standalone commands (only one command, path = "sentry <name>")
    if (
      route.commands.length <= 1 &&
      route.commands[0]?.path === `sentry ${route.name}`
    ) {
      continue;
    }
    result.set(route.name, route);
  }
  return result;
}

/**
 * Given a route map target, find the name of its default command (if any).
 * Compares the default command object reference against all subcommand entries.
 */
function findDefaultInRouteMap(target: RouteMap): string | undefined {
  if (!target.getDefaultCommand) {
    return;
  }
  const defaultCmd = target.getDefaultCommand();
  if (!defaultCmd) {
    return;
  }
  for (const sub of target.getAllEntries()) {
    if (sub.target === defaultCmd) {
      return sub.name.original;
    }
  }
  return;
}

/**
 * Extract the default command name for a route by inspecting the Stricli route map.
 * Returns the default command name (e.g., "serve" for `local`) or undefined.
 */
function getDefaultCommandName(routeName: string): string | undefined {
  for (const entry of routeMap.getAllEntries()) {
    if (entry.name.original !== routeName) {
      continue;
    }
    return findDefaultInRouteMap(entry.target as RouteMap);
  }
  return;
}

const multiCommandRoutes = getMultiCommandRoutes();

for (const [routeName, route] of multiCommandRoutes) {
  const fragmentPath = `${FRAGMENTS_DIR}/${routeName}.md`;
  let content: string;
  try {
    content = await readFile(fragmentPath, "utf-8");
  } catch {
    // Fragment doesn't exist — already caught by Check 1
    continue;
  }

  const defaultCmd = getDefaultCommandName(routeName);

  const missing: string[] = [];
  for (const cmd of route.commands) {
    const sub = cmd.path.slice(`sentry ${routeName} `.length);
    const leaf = sub.split(" ").at(-1) ?? sub;
    const isDefault = leaf === defaultCmd;
    if (!fragmentMentionsSubcommand(content, routeName, cmd, isDefault)) {
      missing.push(sub);
    }
  }

  if (missing.length > 0) {
    const msg =
      `Fragment missing subcommand coverage: ${fragmentPath}\n` +
      `    Not documented: ${missing.join(", ")}\n` +
      `    Hint: add a heading or code example for each (e.g., "sentry ${routeName} ${missing[0]}")`;
    if (isStrict) {
      errors.push(msg);
    } else {
      warnings.push(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

if (warnings.length > 0) {
  console.warn(
    `\n${warnings.length} subcommand coverage warning(s)${isStrict ? " (treated as errors with --strict)" : ""}:\n`
  );
  for (const w of warnings) {
    console.warn(`  ⚠ ${w}`);
  }
}

if (errors.length > 0) {
  console.error(`\nFound ${errors.length} fragment validation error(s):\n`);
  for (const err of errors) {
    console.error(`  ✗ ${err}`);
  }
  process.exit(1);
}

console.log(
  `\nAll ${actualFragments.size} command fragment files valid (${routeNames.size} routes + index)`
);
console.log(
  `All ${REQUIRED_TOP_LEVEL_FRAGMENTS.length} top-level fragment(s) valid`
);
