#!/usr/bin/env tsx
/**
 * Generate Skill Files from Stricli Command Metadata and Docs
 *
 * Introspects the CLI's route tree and merges with documentation
 * to generate structured documentation for AI agents.
 *
 * Produces:
 *   - SKILL.md: compact index with agent guidance + command summaries
 *   - references/*.md: full per-route command documentation
 *   - index.json: skill discovery manifest for .well-known
 *
 * Usage:
 *   tsx script/generate-skill.ts
 *
 * Output:
 *   plugins/sentry-cli/skills/sentry-cli/SKILL.md
 *   plugins/sentry-cli/skills/sentry-cli/references/*.md
 *   docs/public/.well-known/skills/sentry-cli/SKILL.md
 *   docs/public/.well-known/skills/sentry-cli/references (symlink to plugin references)
 *   docs/public/.well-known/skills/index.json
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import type { Token } from "marked";
import { marked } from "marked";
import {
  extractCommandPathFromHeading,
  formatCommandExamples,
  matchExampleToCommand,
} from "./generate-skill-markdown.js";
import { DOCS_CONTENT, DOCS_PUBLIC } from "./paths.js";

// Bootstrap: ensure the generated skill-content module exists before
// importing the route tree (app.ts → agent-skills.ts → skill-content.ts).
// On a fresh checkout the file won't exist, causing a module resolution
// error. Write a minimal stub so the import resolves; the real content
// is generated at the end of this script.
// NOTE: This must run before the dynamic import() below because static
// imports are hoisted by the runtime before any code executes.
const SKILL_CONTENT_PATH = "src/generated/skill-content.ts";
if (!existsSync(SKILL_CONTENT_PATH)) {
  mkdirSync("src/generated", { recursive: true });
  writeFileSync(
    SKILL_CONTENT_PATH,
    "export const SKILL_FILES: ReadonlyMap<string, string> = new Map();\n",
  );
}

const { routes } = await import("../src/app.js");

import type {
  CommandInfo,
  FlagInfo,
  RouteInfo,
  RouteMap,
} from "../src/lib/introspect.js";
import {
  buildCommandInfo,
  extractRouteGroupCommands,
  isCommand,
  isRouteMap,
} from "../src/lib/introspect.js";

/**
 * Resolve the default subcommand name for a route map, if configured.
 *
 * Hidden dispatcher routes (e.g. auth's `default`) map bare group examples
 * onto the user-facing command they primarily document (login).
 */
function findDefaultCommandName(routeMap: RouteMap): string | undefined {
  if (!routeMap.getDefaultCommand) {
    return;
  }
  const defaultCmd = routeMap.getDefaultCommand();
  if (!defaultCmd) {
    return;
  }
  for (const sub of routeMap.getAllEntries()) {
    if (sub.target === defaultCmd) {
      const name = sub.name.original;
      // Auth uses a hidden "default" dispatcher; bare `sentry auth` examples
      // document the login path.
      if (name === "default") {
        return "login";
      }
      return name;
    }
  }
  return;
}

const SKILL_DIR = "plugins/sentry-cli/skills/sentry-cli";
const OUTPUT_PATH = `${SKILL_DIR}/SKILL.md`;
const PUBLIC_SKILL_DIR = `${DOCS_PUBLIC}/.well-known/skills/sentry-cli`;
const INDEX_JSON_PATH = `${DOCS_PUBLIC}/.well-known/skills/index.json`;
const DOCS_PATH = DOCS_CONTENT;

/** Read version from package.json for YAML frontmatter */
async function getPackageVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  return pkg.version;
}

/** Regex to match YAML frontmatter at the start of a file */
const FRONTMATTER_REGEX = /^---\n[\s\S]*?\n---\n/;

/** Regex to match code blocks with optional language specifier */
const CODE_BLOCK_REGEX = /```(\w*)\n([\s\S]*?)```/g;

/** Regex to extract npm command from PackageManagerCode Astro component (handles multi-line) */
const PACKAGE_MANAGER_REGEX = /<PackageManagerCode[\s\S]*?npm="([^"]+)"/;

/**
 * Skill description used in YAML frontmatter and index.json.
 * Kept as a constant to ensure consistency across all generated files.
 */
const SKILL_DESCRIPTION =
  "Guide for using the Sentry CLI to interact with Sentry from the command line. Use when the user asks about viewing issues, events, projects, organizations, making API calls, or authenticating with Sentry via CLI.";

/**
 * Preferred display order for routes in the SKILL.md index.
 * Routes not listed here appear after these in alphabetical order.
 */
const ROUTE_ORDER = ["help", "auth", "org", "project", "issue", "event", "api"];

/**
 * Flags that are globally injected and should be omitted from compact index
 * and only mentioned once in the Global Options section.
 */
const GLOBAL_FLAG_NAMES = new Set([
  "json",
  "fields",
  "help",
  "helpAll",
  "log-level",
]);

// ---------------------------------------------------------------------------
// Markdown Parsing Utilities
// ---------------------------------------------------------------------------

/** Strip YAML frontmatter from markdown content */
function stripFrontmatter(markdown: string): string {
  const match = markdown.match(FRONTMATTER_REGEX);
  return match ? markdown.slice(match[0].length) : markdown;
}

/** Strip MDX/Astro import statements and JSX components */
function stripMdxComponents(markdown: string): string {
  let result = markdown.replace(/^import\s+.*?;\s*$/gm, "");
  result = result.replace(/^export\s+.*?;\s*$/gm, "");
  result = result.replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, "");
  result = result.replace(
    /<[A-Z][a-zA-Z]*[^>]*>[\s\S]*?<\/[A-Z][a-zA-Z]*>/g,
    "",
  );
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/** Extract a specific section from markdown by heading */
function extractSection(markdown: string, heading: string): string | null {
  const headingPattern = new RegExp(
    `^(#{1,6})\\s+${escapeRegex(heading)}\\s*$`,
    "m",
  );
  const match = markdown.match(headingPattern);
  if (!match || match.index === undefined) {
    return null;
  }
  const headingLevel = match[1].length;
  const startIndex = match.index + match[0].length;
  const nextHeadingPattern = new RegExp(`^#{1,${headingLevel}}\\s+`, "m");
  const remainingContent = markdown.slice(startIndex);
  const nextMatch = remainingContent.match(nextHeadingPattern);
  const endIndex = nextMatch?.index
    ? startIndex + nextMatch.index
    : markdown.length;
  return markdown.slice(startIndex, endIndex).trim();
}

/** Extract all code blocks from markdown */
function extractCodeBlocks(
  markdown: string,
  language?: string,
): { code: string; lang: string }[] {
  const blocks: { code: string; lang: string }[] = [];
  const pattern = new RegExp(CODE_BLOCK_REGEX.source, CODE_BLOCK_REGEX.flags);
  let match = pattern.exec(markdown);
  while (match !== null) {
    const lang = match[1] || "";
    const code = match[2].trim();
    if (!language || lang === language) {
      blocks.push({ code, lang });
    }
    match = pattern.exec(markdown);
  }
  return blocks;
}

/** Escape special regex characters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Documentation Loading
// ---------------------------------------------------------------------------

/** Load and parse a documentation file */
async function loadDoc(relativePath: string): Promise<string | null> {
  const fullPath = `${DOCS_PATH}/${relativePath}`;
  const exists = await access(fullPath).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return null;
  }
  const content = await readFile(fullPath, "utf-8");
  return stripMdxComponents(stripFrontmatter(content));
}

/** Extract npm command from PackageManagerCode Astro component */
function extractPackageManagerCommand(rawContent: string): string | null {
  const match = rawContent.match(PACKAGE_MANAGER_REGEX);
  return match ? match[1] : null;
}

/** Generate installation section from docs content */
function generateInstallSection(
  installSection: string,
  rawContent: string,
): string[] {
  const lines: string[] = [];
  lines.push("### Installation");
  lines.push("");
  const codeBlocks = extractCodeBlocks(installSection, "bash");
  const npmCommand = extractPackageManagerCommand(rawContent);
  if (codeBlocks.length > 0 || npmCommand) {
    lines.push("```bash");
    for (const block of codeBlocks) {
      lines.push(block.code);
    }
    if (npmCommand) {
      if (codeBlocks.length > 0) {
        lines.push("");
        lines.push("# Or install via npm/pnpm/bun");
      }
      lines.push(npmCommand);
    }
    lines.push("```");
  }
  return lines;
}

/** Generate authentication section from docs content */
function generateAuthSection(authSection: string): string[] {
  const lines: string[] = [];
  lines.push("### Authentication");
  lines.push("");
  const codeBlocks = extractCodeBlocks(authSection, "bash");
  if (codeBlocks.length > 0) {
    lines.push("```bash");
    for (const block of codeBlocks) {
      lines.push(block.code);
    }
    lines.push("```");
  }
  return lines;
}

/** Load prerequisites (installation + authentication) from getting-started.mdx */
async function loadPrerequisites(): Promise<string> {
  const fullPath = `${DOCS_PATH}/getting-started.mdx`;
  const exists = await access(fullPath).then(
    () => true,
    () => false,
  );
  if (!exists) {
    return getDefaultPrerequisites();
  }
  const rawContent = await readFile(fullPath, "utf-8");
  const content = stripMdxComponents(stripFrontmatter(rawContent));
  const lines: string[] = [];
  lines.push("## Prerequisites");
  lines.push("");
  lines.push("The CLI must be installed and authenticated before use.");
  lines.push("");
  const installSection = extractSection(content, "Install Script");
  if (installSection) {
    lines.push(...generateInstallSection(installSection, rawContent));
  }
  lines.push("");
  const authSection = extractSection(content, "Authentication");
  if (authSection) {
    lines.push(...generateAuthSection(authSection));
  }
  return lines.join("\n");
}

/** Default prerequisites if docs aren't available */
function getDefaultPrerequisites(): string {
  return `## Prerequisites

The CLI must be installed and authenticated before use.

### Installation

\`\`\`bash
# Install script
curl https://cli.sentry.dev/install -fsS | bash

# Or use npm/pnpm/bun
npm install -g sentry
\`\`\`

### Authentication

\`\`\`bash
# OAuth login (recommended)
sentry auth

# Or use an API token
sentry auth --token YOUR_SENTRY_API_TOKEN

# Check auth status
sentry auth status
\`\`\``;
}

/** Append a code block to a map entry, creating the array if needed */
function appendExample(
  map: Map<string, string[]>,
  key: string,
  code: string,
): void {
  const list = map.get(key) ?? [];
  list.push(code);
  map.set(key, list);
}

/**
 * Collect all command paths from `### \`sentry ...\`` headings in a token list.
 * Initializes each path with an empty array in the examples map.
 */
function collectCommandPaths(
  tokens: Token[],
  examples: Map<string, string[]>,
): string[] {
  const paths: string[] = [];
  for (const token of tokens) {
    if (token.type !== "heading" || token.depth !== 3) {
      continue;
    }
    const cmdPath = extractCommandPathFromHeading(token.text);
    if (cmdPath) {
      paths.push(cmdPath);
      if (!examples.has(cmdPath)) {
        examples.set(cmdPath, []);
      }
    }
  }
  return paths;
}

/**
 * Walk tokens sequentially and associate each bash code block with
 * the appropriate command path — either by heading context or content matching.
 */
function associateCodeBlocks(
  tokens: Token[],
  context: {
    commandPaths: string[];
    commandGroup: string;
    examples: Map<string, string[]>;
    defaultCommandPath?: string;
  },
): void {
  const { commandPaths, commandGroup, examples, defaultCommandPath } = context;
  const groupFallback = `sentry ${commandGroup}`;
  let currentCmd: string | null = null;

  for (const token of tokens) {
    if (token.type === "heading" && token.depth === 3) {
      currentCmd = extractCommandPathFromHeading(token.text) ?? null;
    }
    if (token.type !== "code" || token.lang !== "bash") {
      continue;
    }
    const code = token.text.trim();
    if (currentCmd && examples.has(currentCmd)) {
      appendExample(examples, currentCmd, code);
    } else {
      const target = matchExampleToCommand(
        code,
        commandPaths,
        groupFallback,
        defaultCommandPath,
      );
      if (target) {
        appendExample(examples, target, code);
      }
    }
  }
}

/**
 * Load examples for a specific command group from docs using the `marked`
 * AST parser. Walks the token tree to find command headings and associate
 * bash code blocks with each command.
 *
 * Handles both auto-generated reference sections (`### \`sentry ...\`` headings)
 * and hand-written custom sections (`## Examples` with descriptive headings)
 * by matching code blocks to commands via heading context or content analysis.
 */
async function loadCommandExamples(
  commandGroup: string,
  defaultCommandName?: string,
): Promise<Map<string, string[]>> {
  const docContent = await loadDoc(`commands/${commandGroup}.md`);
  if (!docContent) {
    return new Map();
  }

  const tokens = marked.lexer(docContent);
  const examples = new Map<string, string[]>();
  const commandPaths = collectCommandPaths(tokens, examples);
  const defaultCommandPath = defaultCommandName
    ? `sentry ${commandGroup} ${defaultCommandName}`
    : undefined;
  associateCodeBlocks(tokens, {
    commandPaths,
    commandGroup,
    examples,
    defaultCommandPath,
  });
  return examples;
}

/** Load supplementary content from commands/index.md */
async function loadCommandsOverview(): Promise<{
  globalOptions: string;
  jsonOutput: string;
  webFlag: string;
} | null> {
  const content = await loadDoc("commands/index.md");
  if (!content) {
    return null;
  }
  const globalSection = extractSection(content, "Global Options");
  const jsonSection = extractSection(content, "JSON Output");
  const webSection = extractSection(content, "Opening in Browser");
  return {
    globalOptions: globalSection || "",
    jsonOutput: jsonSection || "",
    webFlag: webSection || "",
  };
}

/**
 * Load agent guidance content from docs/src/content/docs/agent-guidance.md.
 * Returns the body content (frontmatter and title stripped).
 */
async function loadAgentGuidance(): Promise<string | null> {
  return await loadDoc("agent-guidance.md");
}

// ---------------------------------------------------------------------------
// Route Introspection (with async doc loading)
// ---------------------------------------------------------------------------

/**
 * Walk the route tree and extract command information with doc examples.
 * This is the async version that loads documentation examples from disk.
 */
async function extractRoutes(routeMap: RouteMap): Promise<RouteInfo[]> {
  const result: RouteInfo[] = [];
  for (const entry of routeMap.getAllEntries()) {
    if (entry.hidden) {
      continue;
    }
    const routeName = entry.name.original;
    const target = entry.target;
    const defaultCommandName = isRouteMap(target)
      ? findDefaultCommandName(target)
      : undefined;
    const docExamples = await loadCommandExamples(
      routeName,
      defaultCommandName,
    );
    if (isRouteMap(target)) {
      result.push({
        name: routeName,
        brief: target.brief,
        commands: extractRouteGroupCommands(target, routeName, docExamples),
      });
    } else if (isCommand(target)) {
      const path = `sentry ${routeName}`;
      const examples = docExamples.get(path) ?? [];
      result.push({
        name: routeName,
        brief: target.brief,
        commands: [buildCommandInfo(target, path, examples)],
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** Sort routes by the preferred display order */
function sortRoutes(routeInfos: RouteInfo[]): RouteInfo[] {
  return [...routeInfos].sort((a, b) => {
    const aIndex = ROUTE_ORDER.indexOf(a.name);
    const bIndex = ROUTE_ORDER.indexOf(b.name);
    const aOrder = aIndex === -1 ? 999 : aIndex;
    const bOrder = bIndex === -1 ? 999 : bIndex;
    return aOrder - bOrder;
  });
}

// ---------------------------------------------------------------------------
// Markdown Formatting Helpers
// ---------------------------------------------------------------------------

/** Format a flag for display in documentation */
function formatFlag(flag: FlagInfo, aliases: Record<string, string>): string {
  const parts: string[] = [];
  const alias = Object.entries(aliases).find(([, v]) => v === flag.name)?.[0];
  let syntax = `--${flag.name}`;
  if (alias) {
    syntax = `-${alias}, ${syntax}`;
  }
  if ((flag.kind === "parsed" || flag.kind === "enum") && !flag.variadic) {
    syntax += " <value>";
  } else if (flag.variadic) {
    syntax += " <value>...";
  }
  parts.push(syntax);
  if (flag.brief) {
    parts.push(flag.brief);
  }
  if (flag.default !== undefined && flag.kind !== "boolean") {
    parts.push(`(default: ${JSON.stringify(flag.default)})`);
  }
  return parts.join(" - ");
}

/**
 * Get the visible, non-global flags for a command.
 * Excludes hidden flags, help, and globally-injected flags.
 */
function getVisibleFlags(cmd: CommandInfo): FlagInfo[] {
  return cmd.flags.filter((f) => !(f.hidden || GLOBAL_FLAG_NAMES.has(f.name)));
}

// ---------------------------------------------------------------------------
// Reference File Generation (full detail)
// ---------------------------------------------------------------------------

/** Generate full documentation for a single command (used in reference files) */
function generateFullCommandDoc(cmd: CommandInfo): string {
  const lines: string[] = [];
  const signature = cmd.positional ? `${cmd.path} ${cmd.positional}` : cmd.path;
  lines.push(`### \`${signature}\``);
  lines.push("");
  lines.push(cmd.brief);

  const visibleFlags = getVisibleFlags(cmd);
  if (visibleFlags.length > 0) {
    lines.push("");
    lines.push("**Flags:**");
    for (const flag of visibleFlags) {
      lines.push(`- \`${formatFlag(flag, cmd.aliases)}\``);
    }
  }

  if (cmd.jsonFields && cmd.jsonFields.length > 0) {
    lines.push("");
    lines.push(
      "**JSON Fields** (use `--json --fields` to select specific fields):",
    );
    lines.push("");
    lines.push("| Field | Type | Description |");
    lines.push("|-------|------|-------------|");
    for (const field of cmd.jsonFields) {
      // Escape pipe characters to avoid breaking the markdown table structure
      const safeType = field.type.replaceAll("|", "\\|");
      const safeDesc = (field.description ?? "").replaceAll("|", "\\|");
      lines.push(`| \`${field.name}\` | ${safeType} | ${safeDesc} |`);
    }
  }

  const examples = formatCommandExamples(cmd.examples);
  if (examples) {
    lines.push("", examples);
  }

  return lines.join("\n");
}

/** Known acronyms that should be fully uppercased in titles */
const TITLE_ACRONYMS = new Set(["api", "cli"]);

/** Capitalize a route name for display, uppercasing known acronyms */
function capitalize(s: string): string {
  if (TITLE_ACRONYMS.has(s)) {
    return s.toUpperCase();
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Generate a complete reference file for a single route.
 *
 * Title and description are derived from route metadata — no manual
 * mapping required. Each route produces its own reference file.
 *
 * @param refName - Reference file key (same as route name)
 * @param groupRoutes - Single-element array with the route
 * @param version - CLI version for frontmatter
 */
function generateReferenceFile(
  refName: string,
  groupRoutes: RouteInfo[],
  version: string,
): string {
  const route = groupRoutes[0];
  const title = `${capitalize(refName)} Commands`;
  const description = route.brief;

  const lines: string[] = [];

  // YAML frontmatter
  lines.push("---");
  lines.push(`name: sentry-cli-${refName}`);
  lines.push(`version: ${version}`);
  lines.push(`description: ${description}`);
  lines.push("requires:");
  lines.push('  bins: ["sentry"]');
  lines.push("  auth: true");
  lines.push("---");
  lines.push("");

  lines.push(`# ${title}`);
  lines.push("");

  lines.push(route.brief);
  lines.push("");

  // Full command docs
  for (const cmd of route.commands) {
    lines.push(generateFullCommandDoc(cmd));
    lines.push("");
  }

  // Note about global flags
  lines.push(
    "All commands also support `--json`, `--fields`, `--help`, `--log-level`, and `--verbose` flags.",
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// SKILL.md Index Generation (compact)
// ---------------------------------------------------------------------------

/**
 * Generate a compact command summary for the SKILL.md index.
 * Includes the command signature and brief, but NOT full flags or examples.
 */
function generateCompactCommandLine(cmd: CommandInfo): string {
  const signature = cmd.positional ? `${cmd.path} ${cmd.positional}` : cmd.path;
  return `- \`${signature}\` — ${cmd.brief}`;
}

/**
 * Generate the compact command reference section for SKILL.md.
 * Each route gets a heading, brief, command list, and a pointer to its reference file.
 */
function generateCompactCommandsSection(
  routeInfos: RouteInfo[],
  referenceFiles: Map<string, string>,
): string {
  const lines: string[] = [];
  lines.push("## Command Reference");
  lines.push("");

  const sortedRoutes = sortRoutes(routeInfos);

  for (const route of sortedRoutes) {
    if (route.name === "help") {
      continue;
    }

    lines.push(`### ${capitalize(route.name)}`);
    lines.push("");
    lines.push(route.brief);
    lines.push("");

    for (const cmd of route.commands) {
      lines.push(generateCompactCommandLine(cmd));
    }

    // Add reference file pointer (1:1 route-to-file mapping)
    const refFile = referenceFiles.get(route.name);
    if (refFile) {
      lines.push("");
      lines.push(`→ Full flags and examples: \`references/${refFile}\``);
    }

    lines.push("");
  }

  return lines.join("\n");
}

/** Generate supplementary sections (Global Options, Output Formats) from docs */
async function generateSupplementarySections(): Promise<string> {
  const overview = await loadCommandsOverview();
  const lines: string[] = [];

  if (overview?.globalOptions) {
    lines.push("## Global Options");
    lines.push("");
    lines.push(overview.globalOptions);
    lines.push("");
  }

  lines.push("## Output Formats");
  lines.push("");

  if (overview?.jsonOutput) {
    lines.push("### JSON Output");
    lines.push("");
    lines.push(overview.jsonOutput);
    lines.push("");
  } else {
    lines.push(
      "Most commands support `--json` flag for JSON output, making it easy to integrate with other tools.",
    );
    lines.push("");
  }

  if (overview?.webFlag) {
    lines.push("### Opening in Browser");
    lines.push("");
    lines.push(overview.webFlag);
  } else {
    lines.push(
      "View commands support `-w` or `--web` flag to open the resource in your browser.",
    );
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Multi-File Generation
// ---------------------------------------------------------------------------

/** Result of generating all skill files */
type GeneratedFiles = Map<string, string>;

/**
 * Map each route to its own reference file (1:1 mapping).
 *
 * Every visible route produces its own reference file, matching the
 * strategy used by generate-command-docs.ts. This eliminates the
 * need for manual route-to-reference mappings that can go stale.
 */
function groupRoutesByReference(
  routeInfos: RouteInfo[],
): Map<string, RouteInfo[]> {
  const groups = new Map<string, RouteInfo[]>();
  for (const route of routeInfos) {
    if (route.name === "help") {
      continue;
    }
    groups.set(route.name, [route]);
  }
  return groups;
}

/**
 * Generate all skill files: SKILL.md index + per-route reference files.
 *
 * @returns Map of relative file paths → content
 */
async function generateAllSkillFiles(
  routeMap: RouteMap,
): Promise<GeneratedFiles> {
  const files: GeneratedFiles = new Map();
  const version = await getPackageVersion();
  const routeInfos = await extractRoutes(routeMap);
  const prerequisites = await loadPrerequisites();
  const supplementary = await generateSupplementarySections();
  const agentGuidance = await loadAgentGuidance();

  // Map each route to its own reference file (1:1)
  const routeGroups = groupRoutesByReference(routeInfos);

  // Generate reference files
  const referenceFileNames = new Map<string, string>();
  for (const [refName, groupRoutes] of routeGroups) {
    const fileName = `${refName}.md`;
    referenceFileNames.set(refName, fileName);
    const content = generateReferenceFile(refName, groupRoutes, version);
    files.set(`references/${fileName}`, content);
  }

  // Generate SKILL.md (compact index)
  const indexSections = [
    // YAML frontmatter
    "---",
    "name: sentry-cli",
    `version: ${version}`,
    `description: ${SKILL_DESCRIPTION}`,
    "requires:",
    `  bins: ["sentry"]`,
    "  auth: true",
    "---",
    "",
    "# Sentry CLI Usage Guide",
    "",
    "Help users interact with Sentry from the command line using the `sentry` CLI.",
    "",
    "> **Core rule for agents: just run the command.** The `sentry` CLI auto-detects your org and project (from `.sentryclirc`, DSNs in `.env`/source, and the directory name), so **do not** list organizations and then list their projects to work out which one this checkout maps to — that manual discovery only duplicates work the CLI already does on every command. Pass an explicit `<org>/<project>` only when the CLI reports it can't detect the target or picks the wrong one.",
    "",
  ];

  // Agent guidance section — bump heading levels down by one so they nest
  // under ## Agent Guidance (## → ###, ### → ####, etc.)
  if (agentGuidance) {
    indexSections.push("## Agent Guidance");
    indexSections.push("");
    const nestedGuidance = agentGuidance.replace(
      /^(#{2,6})\s/gm,
      (_, hashes: string) => `#${hashes} `,
    );
    indexSections.push(nestedGuidance);
    indexSections.push("");
  }

  // Prerequisites
  indexSections.push(prerequisites);
  indexSections.push("");

  // Compact command reference
  indexSections.push(
    generateCompactCommandsSection(routeInfos, referenceFileNames),
  );

  // Supplementary sections
  indexSections.push(supplementary);
  indexSections.push("");

  files.set("SKILL.md", indexSections.join("\n"));

  return files;
}

/**
 * Generate the .well-known/skills/index.json discovery manifest.
 * Lists all generated files for external tooling to discover.
 */
function generateIndexJson(generatedFiles: GeneratedFiles): string {
  const fileList = [...generatedFiles.keys()].sort((a, b) => {
    // SKILL.md always first
    if (a === "SKILL.md") {
      return -1;
    }
    if (b === "SKILL.md") {
      return 1;
    }
    return a.localeCompare(b);
  });

  const index = {
    skills: [
      {
        name: "sentry-cli",
        description: SKILL_DESCRIPTION,
        files: fileList,
      },
    ],
  };

  return `${JSON.stringify(index, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const files = await generateAllSkillFiles(routes as unknown as RouteMap);

// The public references are a symlink to these generated plugin references.
rmSync(`${SKILL_DIR}/references`, { recursive: true, force: true });
for (const [relativePath, content] of files) {
  const fullPath = `${SKILL_DIR}/${relativePath}`;
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  await writeFile(fullPath, content);
}

const publicSkill = files.get("SKILL.md");
if (publicSkill === undefined) {
  throw new Error("Generated skill is missing SKILL.md");
}
mkdirSync(PUBLIC_SKILL_DIR, { recursive: true });
await writeFile(`${PUBLIC_SKILL_DIR}/SKILL.md`, publicSkill);

// Write index.json
const indexJson = generateIndexJson(files);
const indexJsonDir = INDEX_JSON_PATH.substring(
  0,
  INDEX_JSON_PATH.lastIndexOf("/"),
);
mkdirSync(indexJsonDir, { recursive: true });
await writeFile(INDEX_JSON_PATH, indexJson);

// Generate src/generated/skill-content.ts with inlined file contents.
// This embeds all skill files into the binary at build time so that
// agent-skills.ts can install them without any network fetching.
const skillEntries = [...files.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, content]) => {
    const escaped = content
      .replaceAll("\\", "\\\\")
      .replaceAll("`", "\\`")
      .replaceAll("${", "\\${");
    return `  ["${path}", \`${escaped}\`],`;
  })
  .join("\n");

const skillContentModule = `/**
 * Embedded skill file contents for agent skill installation.
 * Auto-generated by script/generate-skill.ts — do not edit manually.
 */

/** Map of relative path → file content for all skill files */
export const SKILL_FILES: ReadonlyMap<string, string> = new Map([
${skillEntries}
]);
`;

await writeFile(SKILL_CONTENT_PATH, skillContentModule);

// Report what was generated
const refCount = [...files.keys()].filter((k) =>
  k.startsWith("references/"),
).length;
console.log(
  `Generated ${OUTPUT_PATH} + ${refCount} reference files + ${INDEX_JSON_PATH} + ${SKILL_CONTENT_PATH}`,
);
