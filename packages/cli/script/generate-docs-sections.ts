#!/usr/bin/env tsx
/**
 * Generate Documentation Sections (Marker-Based)
 *
 * Injects auto-generated content into hand-written documentation files
 * between <!-- GENERATED:START name --> and <!-- GENERATED:END name --> markers.
 *
 * Sections:
 *   - contributing.md:  project structure tree, dev prerequisites
 *   - DEVELOPMENT.md:   OAuth scopes, env var table
 *   - self-hosted.md:   OAuth scopes, env var table
 *   - README.md:        dev prerequisites, library prerequisites, dev scripts
 *   - getting-started.mdx: platform support table
 *
 * Unlike generate-command-docs.ts (which produces gitignored files from scratch),
 * this script edits committed files in-place between marker pairs.
 *
 * Usage:
 *   tsx script/generate-docs-sections.ts          # Generate (write)
 *   tsx script/generate-docs-sections.ts --check   # Dry-run, exit 1 if stale
 */

import { mkdirSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { DOCS_CONTENT } from "./paths.js";

// Bootstrap: skill-content stub (same pattern as generate-command-docs.ts)
const SKILL_CONTENT_PATH = "src/generated/skill-content.ts";
const SKILL_CONTENT_STUB =
  "export const SKILL_FILES: [string, string][] = [];\n";
const skillContentExists = await access(SKILL_CONTENT_PATH).then(
  () => true,
  () => false,
);
if (!skillContentExists) {
  mkdirSync("src/generated", { recursive: true });
  await writeFile(SKILL_CONTENT_PATH, SKILL_CONTENT_STUB);
}

import type { EnvVarEntry } from "../src/lib/env-registry.js";
import type { RouteInfo, RouteMap } from "../src/lib/introspect.js";

const { routes } = await import("../src/app.js");
const { extractAllRoutes } = await import("../src/lib/introspect.js");
const { OAUTH_SCOPES } = await import("../src/lib/oauth.js");
const { ENV_VAR_REGISTRY } = await import("../src/lib/env-registry.js");
const pkg = JSON.parse(await readFile("package.json", "utf-8"));
const workspace = JSON.parse(await readFile("../../package.json", "utf-8"));

const isCheck = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Marker Replacement
// ---------------------------------------------------------------------------

/**
 * Supported marker comment styles.
 * HTML: `&lt;!-- GENERATED:START name --&gt;` (for .md files)
 * MDX:  JSX comment `GENERATED:START name` (for .mdx files)
 */
type MarkerStyle = "html" | "mdx";

function markerTags(
  sectionName: string,
  style: MarkerStyle,
): { startTag: string; endTag: string } {
  if (style === "mdx") {
    return {
      startTag: `{/* GENERATED:START ${sectionName} */}`,
      endTag: `{/* GENERATED:END ${sectionName} */}`,
    };
  }
  return {
    startTag: `<!-- GENERATED:START ${sectionName} -->`,
    endTag: `<!-- GENERATED:END ${sectionName} -->`,
  };
}

/**
 * Replace content between named marker pairs in a string.
 *
 * Expects exactly one pair of markers:
 *   <!-- GENERATED:START sectionName -->
 *   ...content to replace...
 *   <!-- GENERATED:END sectionName -->
 *
 * Returns the string with the content between markers replaced by `generated`.
 * Throws if markers are missing or out of order.
 */
function replaceMarkerSection(
  content: string,
  sectionName: string,
  generated: string,
  style: MarkerStyle = "html",
): string {
  const { startTag, endTag } = markerTags(sectionName, style);

  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);

  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `Missing markers for section "${sectionName}": ` +
        `start=${startIdx !== -1}, end=${endIdx !== -1}`,
    );
  }
  if (startIdx > endIdx) {
    throw new Error(`Markers out of order for section "${sectionName}"`);
  }

  const before = content.slice(0, startIdx + startTag.length);
  const after = content.slice(endIdx);
  const sep = style === "mdx" ? "\n\n" : "\n";
  return `${before}${sep}${generated}${sep}${after}`;
}

// ---------------------------------------------------------------------------
// Section: Project Structure (contributing.md)
// ---------------------------------------------------------------------------

/** Routes that are excluded from documentation pages and the project tree */
const SKIP_ROUTES = new Set(["help"]);

/**
 * Determine if a route is a standalone command (not a group with subcommands).
 * Standalone commands live as .ts files directly in src/commands/,
 * while groups are subdirectories.
 */
function isStandaloneCommand(route: RouteInfo): boolean {
  return (
    route.commands.length === 1 &&
    route.commands[0].path === `sentry ${route.name}`
  );
}

/**
 * Get subcommand names for a route group (e.g., "list, view, create").
 * Extracts the last path segment from each command's path, deduplicated
 * and sorted (nested routes like `issues` / `metrics` would otherwise repeat
 * the same subcommand list twice, e.g. for `alert/`).
 */
function getSubcommandLabel(route: RouteInfo): string {
  const raw = route.commands.map((cmd) => {
    const parts = cmd.path.split(" ");
    return parts.at(-1) ?? route.name;
  });
  return Array.from(new Set(raw))
    .sort((a, b) => a.localeCompare(b))
    .join(", ");
}

/**
 * Generate the project structure tree for contributing.md.
 *
 * Combines static entries (bin.ts, app.ts, etc.) with dynamic
 * command directories/files extracted from the route tree.
 */
function generateProjectStructure(allRoutes: RouteInfo[]): string {
  const lines: string[] = [];
  lines.push("```");
  lines.push("toolkit/");
  lines.push("├── packages/");
  lines.push("│   └── cli/");
  lines.push("│       ├── src/");
  lines.push("│       │   ├── bin.ts          # Entry point");
  lines.push("│       │   ├── app.ts          # Stricli application setup");
  lines.push("│       │   ├── context.ts      # Dependency injection context");
  lines.push("│       │   ├── commands/       # CLI commands");

  // Separate routes into groups (directories) and standalone (files)
  const groups: RouteInfo[] = [];
  const standalones: RouteInfo[] = [];
  for (const route of allRoutes) {
    if (SKIP_ROUTES.has(route.name)) {
      continue;
    }
    if (isStandaloneCommand(route)) {
      standalones.push(route);
    } else {
      groups.push(route);
    }
  }

  // Sort both alphabetically
  groups.sort((a, b) => a.name.localeCompare(b.name));
  standalones.sort((a, b) => a.name.localeCompare(b.name));

  // Render group directories (always use ├── since standalones follow)
  for (const route of groups) {
    const subcmds = getSubcommandLabel(route);
    lines.push(
      `│       │   │   ├── ${`${route.name}/`.padEnd(13)}# ${subcmds}`,
    );
  }

  // Combine standalone commands with help.ts (which is in SKIP_ROUTES
  // for doc generation but still exists in the filesystem).
  // Add help before sorting so it lands in correct alphabetical position.
  const allStandaloneEntries: { name: string; brief: string }[] =
    standalones.map((r) => ({ name: r.name, brief: r.commands[0].brief }));
  allStandaloneEntries.push({ name: "help", brief: "Help command" });
  allStandaloneEntries.sort((a, b) => a.name.localeCompare(b.name));

  // Render standalone command files
  for (let i = 0; i < allStandaloneEntries.length; i += 1) {
    const entry = allStandaloneEntries[i];
    const isLast = i === allStandaloneEntries.length - 1;
    const prefix = isLast ? "└──" : "├──";
    lines.push(
      `│       │   │   ${prefix} ${`${entry.name}.ts`.padEnd(13)}# ${entry.brief}`,
    );
  }

  lines.push("│       │   ├── lib/            # Shared utilities");
  lines.push(
    "│       │   └── types/          # TypeScript types and Valibot schemas",
  );
  lines.push(
    "│       ├── test/               # Test files (mirrors src/ structure)",
  );
  lines.push("│       ├── script/             # Build and utility scripts");
  lines.push("│       └── plugins/            # Agent skill files");
  lines.push("└── apps/");
  lines.push(
    "    └── cli-docs/             # Documentation site (Astro + Starlight)",
  );
  lines.push("```");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section: OAuth Scopes (DEVELOPMENT.md, self-hosted.md)
// ---------------------------------------------------------------------------

/**
 * Group OAuth scopes by resource prefix (the part before the colon).
 * Returns groups in insertion order.
 */
function groupScopesByResource(
  scopes: readonly string[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const scope of scopes) {
    const resource = scope.split(":")[0];
    const existing = groups.get(resource);
    if (existing) {
      existing.push(scope);
    } else {
      groups.set(resource, [scope]);
    }
  }
  return groups;
}

/**
 * Generate scopes as a bullet list for DEVELOPMENT.md.
 * Groups by resource prefix, each group on one line.
 */
function generateScopesBulletList(scopes: readonly string[]): string {
  const grouped = groupScopesByResource(scopes);
  const lines: string[] = [];
  for (const scopeGroup of grouped.values()) {
    const formatted = scopeGroup.map((s) => `\`${s}\``).join(", ");
    lines.push(`  - ${formatted}`);
  }
  return lines.join("\n");
}

/**
 * Generate scopes as an inline comma-separated list for self-hosted.md.
 */
function generateScopesInline(scopes: readonly string[]): string {
  return scopes.map((s) => `\`${s}\``).join(", ");
}

// ---------------------------------------------------------------------------
// Section: Prerequisites (README.md, contributing.md)
// ---------------------------------------------------------------------------

const PNPM_VERSION_RE = /pnpm@(\d+\.\d+)/;
const SEMVER_RE = /(\d+\.\d+)/;

/**
 * Extract the pnpm major.minor version from the `packageManager` field.
 * `pnpm@10.11.0` → `10.11`
 *
 * Throws if `packageManager` doesn't match the expected format —
 * silent fallbacks caused stale Bun prerequisites after the Bun→Node migration.
 */
function extractPnpmVersion(): string {
  const pm: string = workspace.packageManager ?? "";
  const match = pm.match(PNPM_VERSION_RE);
  if (!match) {
    throw new Error(
      `Cannot extract pnpm version from packageManager: "${pm}". ` +
        "Expected format: pnpm@X.Y.Z",
    );
  }
  return match[1];
}

/**
 * Extract the Node.js minimum version from `engines.node`.
 * `>=22.15` → `22.15`
 *
 * Throws if `engines.node` is missing or doesn't contain a semver-like version.
 */
function extractNodeVersion(): string {
  const constraint: string | undefined = pkg.engines?.node;
  if (!constraint) {
    throw new Error("Missing engines.node in package.json");
  }
  const match = constraint.match(SEMVER_RE);
  if (!match) {
    throw new Error(
      `Cannot extract Node.js version from engines.node: "${constraint}". ` +
        "Expected a semver-like version (e.g., >=22.15)",
    );
  }
  return match[1];
}

/**
 * Extract the Node.js minimum version for *development* from
 * `devEngines.runtime.version`, falling back to `engines.node`.
 *
 * The published package supports a lower Node.js floor than local
 * development: consumers on older Node.js use a bundled WASM SQLite driver,
 * but contributors run the sources directly (tsx) against `node:sqlite`,
 * which requires Node.js 22.15+. This keeps the two floors independent.
 */
function extractDevNodeVersion(): string {
  const constraint: string | undefined =
    (pkg as any).devEngines?.runtime?.version ?? pkg.engines?.node;
  if (!constraint) {
    throw new Error("Missing devEngines.runtime.version and engines.node");
  }
  const match = constraint.match(SEMVER_RE);
  if (!match) {
    throw new Error(
      `Cannot extract dev Node.js version from "${constraint}". ` +
        "Expected a semver-like version (e.g., >=22.15)",
    );
  }
  return match[1];
}

/** Generate dev prerequisite line for README.md. */
function generateDevPrereq(): string {
  return `- [Node.js](https://nodejs.org) v${extractDevNodeVersion()}+ and [pnpm](https://pnpm.io) v${extractPnpmVersion()}+`;
}

/** Generate dev prerequisite lines for contributing.md. */
function generateDevPrereqContributing(): string {
  return [
    `- [Node.js](https://nodejs.org) (v${extractDevNodeVersion()} or later)`,
    `- [pnpm](https://pnpm.io) (v${extractPnpmVersion()} or later)`,
  ].join("\n");
}

/** Generate the library-usage prerequisite line for README.md. */
function generateLibraryPrereq(): string {
  return `Use Sentry CLI programmatically in Node.js (≥${extractNodeVersion()}) without spawning a subprocess:`;
}

/** Generate dev prerequisite lines for DEVELOPMENT.md. */
function generateDevPrereqDevelopment(): string {
  return [
    `- [Node.js](https://nodejs.org/) v${extractDevNodeVersion()}+ installed`,
    `- [pnpm](https://pnpm.io/) v${extractPnpmVersion()}+ installed`,
  ].join("\n");
}

/** Generate build toolchain description for DEVELOPMENT.md. */
function generateBuildToolchain(): string {
  return [
    "Build the native binary (uses esbuild for bundling and fossilize for Node SEA packaging):",
    "",
    "```bash",
    "pnpm run build",
    "```",
  ].join("\n");
}

/** Generate build commands section for contributing.md. */
function generateBuildCommands(): string {
  return [
    "```bash",
    "# Build for current platform (uses esbuild + fossilize for Node SEA packaging)",
    "pnpm run build",
    "",
    "# Build for all platforms",
    "pnpm run build:all",
    "",
    "# Create npm bundle",
    "pnpm run bundle",
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Section: Dev Scripts (README.md)
// ---------------------------------------------------------------------------

/**
 * Generate the development scripts block for README.md.
 *
 * These are a curated subset of package.json scripts — not all scripts
 * are user-facing. The list is hardcoded because script descriptions
 * aren't machine-readable from package.json.
 */
function generateDevScripts(): string {
  const scripts: [string, string][] = [
    ["pnpm run build", "Build for current platform"],
    ["pnpm run typecheck", "Type checking"],
    ["pnpm run lint", "Check for issues"],
    ["pnpm run lint:fix", "Auto-fix issues"],
    ["pnpm run test:unit", "Run unit tests"],
    ["pnpm run test:e2e", "Run end-to-end tests"],
    ["pnpm run generate:docs", "Regenerate command docs and skills"],
  ];
  const maxCmd = Math.max(...scripts.map(([cmd]) => cmd.length));
  const lines = scripts.map(([cmd, desc]) => `${cmd.padEnd(maxCmd)} # ${desc}`);
  return `\`\`\`bash\n${lines.join("\n")}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// Section: Env Var Tables (DEVELOPMENT.md, self-hosted.md)
// ---------------------------------------------------------------------------

/**
 * Generate the DEVELOPMENT.md env var table from registry entries
 * tagged with `devGuide`.
 */
function generateDevEnvVarsTable(): string {
  const entries = ENV_VAR_REGISTRY.filter(
    (e: EnvVarEntry) => e.devGuide !== undefined,
  );
  const lines: string[] = [
    "| Variable | Description | Default |",
    "|----------|-------------|---------|",
  ];
  for (const entry of entries) {
    const name = `\`${entry.name}\``;
    const desc = entry.devGuide ?? "";
    let defaultCol = "—";
    if (entry.name === "SENTRY_CLIENT_ID") {
      defaultCol = "(required for build)";
    } else if (entry.defaultValue) {
      defaultCol = `\`${entry.defaultValue}\``;
    }
    lines.push(`| ${name} | ${desc} | ${defaultCol} |`);
  }
  return lines.join("\n");
}

/** Short descriptions for the self-hosted env var table, ordered for self-hosted context. */
const SELF_HOSTED_TABLE_ENTRIES: readonly [string, string][] = [
  [
    "SENTRY_HOST",
    "Base URL of your Sentry instance (takes precedence over `SENTRY_URL`)",
  ],
  ["SENTRY_URL", "Alias for `SENTRY_HOST`"],
  ["SENTRY_CLIENT_ID", "Client ID of your public OAuth application"],
  [
    "SENTRY_CUSTOM_HEADERS",
    "Custom HTTP headers for proxy/IAP (semicolon-separated `Name: Value` pairs)",
  ],
  ["SENTRY_FORCE_ENV_TOKEN", "Force env token over stored OAuth token"],
  ["SENTRY_ORG", "Default organization slug"],
  ["SENTRY_PROJECT", "Default project slug (supports `org/project` format)"],
  [
    "NODE_EXTRA_CA_CERTS",
    "Path to PEM file with additional CA certificates (for corporate proxies)",
  ],
];

/**
 * Generate the self-hosted.md env var table.
 *
 * Uses a curated order (URL vars first) rather than registry order,
 * but validates at generation time that every entry in the table
 * has `selfHosted: true` in the registry.
 */
function generateSelfHostedEnvVarsTable(): string {
  const selfHostedNames = new Set(
    ENV_VAR_REGISTRY.filter((e: EnvVarEntry) => e.selfHosted === true).map(
      (e: EnvVarEntry) => e.name,
    ),
  );
  for (const [name] of SELF_HOSTED_TABLE_ENTRIES) {
    if (!selfHostedNames.has(name)) {
      throw new Error(
        `Self-hosted table entry "${name}" is not tagged selfHosted in env-registry.ts`,
      );
    }
  }
  if (selfHostedNames.size !== SELF_HOSTED_TABLE_ENTRIES.length) {
    const missing = [...selfHostedNames].filter(
      (n) => !SELF_HOSTED_TABLE_ENTRIES.some(([name]) => name === n),
    );
    throw new Error(
      `Registry entries tagged selfHosted but missing from self-hosted table: ${missing.join(", ")}`,
    );
  }

  const lines: string[] = [
    "| Variable | Description |",
    "|----------|-------------|",
  ];
  for (const [name, desc] of SELF_HOSTED_TABLE_ENTRIES) {
    lines.push(`| \`${name}\` | ${desc} |`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section: Platform Support (getting-started.mdx)
// ---------------------------------------------------------------------------

/**
 * Platform support table rows.
 *
 * Derived from ALL_TARGETS in script/build.ts. Update this when
 * adding or removing build targets.
 */
const PLATFORM_ROWS: readonly [string, string, string][] = [
  ["macOS", "x64, arm64 (Apple Silicon)", ""],
  ["Linux", "x64, arm64", "Standalone binary requires glibc"],
  ["Windows", "x64", "Via Git Bash, MSYS2, or WSL"],
];

/** Generate the platform support table for getting-started.mdx. */
function generatePlatformSupport(): string {
  const lines: string[] = [
    "<table>",
    "  <thead>",
    "    <tr>",
    "      <th>OS</th>",
    "      <th>Architectures</th>",
    "      <th>Notes</th>",
    "    </tr>",
    "  </thead>",
    "  <tbody>",
  ];
  for (const [os, archs, notes] of PLATFORM_ROWS) {
    lines.push("    <tr>");
    lines.push(`      <td><strong>${os}</strong></td>`);
    lines.push(`      <td>${archs}</td>`);
    lines.push(`      <td>${notes}</td>`);
    lines.push("    </tr>");
  }
  lines.push("  </tbody>");
  lines.push("</table>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section Definitions
// ---------------------------------------------------------------------------

type SectionDef = {
  filePath: string;
  sectionName: string;
  generate: () => string;
  /** Marker comment style. Defaults to `"html"`. */
  markerStyle?: MarkerStyle;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const routeMap = routes as unknown as RouteMap;
const routeInfos = extractAllRoutes(routeMap);

const sections: SectionDef[] = [
  // -- Existing sections --
  {
    filePath: `${DOCS_CONTENT}/contributing.md`,
    sectionName: "project-structure",
    generate: () => generateProjectStructure(routeInfos),
  },
  {
    filePath: "DEVELOPMENT.md",
    sectionName: "oauth-scopes",
    generate: () => generateScopesBulletList(OAUTH_SCOPES),
  },
  {
    filePath: `${DOCS_CONTENT}/self-hosted.md`,
    sectionName: "oauth-scopes",
    generate: () => generateScopesInline(OAUTH_SCOPES),
  },
  // -- Prerequisites (version numbers from package.json) --
  {
    filePath: "README.md",
    sectionName: "dev-prereq",
    generate: generateDevPrereq,
  },
  {
    filePath: "README.md",
    sectionName: "library-prereq",
    generate: generateLibraryPrereq,
  },
  {
    filePath: `${DOCS_CONTENT}/contributing.md`,
    sectionName: "dev-prereq",
    generate: generateDevPrereqContributing,
  },
  {
    filePath: "DEVELOPMENT.md",
    sectionName: "dev-prereq",
    generate: generateDevPrereqDevelopment,
  },
  {
    filePath: "DEVELOPMENT.md",
    sectionName: "build-toolchain",
    generate: generateBuildToolchain,
  },
  {
    filePath: `${DOCS_CONTENT}/contributing.md`,
    sectionName: "build-commands",
    generate: generateBuildCommands,
  },
  // -- Dev scripts (README.md) --
  {
    filePath: "README.md",
    sectionName: "dev-scripts",
    generate: generateDevScripts,
  },
  // -- Env var tables --
  {
    filePath: "DEVELOPMENT.md",
    sectionName: "dev-env-vars",
    generate: generateDevEnvVarsTable,
  },
  {
    filePath: `${DOCS_CONTENT}/self-hosted.md`,
    sectionName: "self-hosted-env-vars",
    generate: generateSelfHostedEnvVarsTable,
  },
  // -- Platform support (getting-started.mdx) --
  {
    filePath: `${DOCS_CONTENT}/getting-started.mdx`,
    sectionName: "platform-support",
    generate: generatePlatformSupport,
    markerStyle: "mdx",
  },
];

let staleCount = 0;

for (const section of sections) {
  const original = await readFile(section.filePath, "utf-8");
  const generated = section.generate();
  const updated = replaceMarkerSection(
    original,
    section.sectionName,
    generated,
    section.markerStyle ?? "html",
  );

  if (updated !== original) {
    if (isCheck) {
      console.error(`STALE: ${section.filePath} [${section.sectionName}]`);
      staleCount += 1;
    } else {
      await writeFile(section.filePath, updated);
      console.log(`Updated: ${section.filePath} [${section.sectionName}]`);
    }
  } else {
    console.log(`Up to date: ${section.filePath} [${section.sectionName}]`);
  }
}

if (isCheck && staleCount > 0) {
  console.error(
    `\n${staleCount} section(s) are stale. Run: pnpm run generate:docs`,
  );
  process.exit(1);
}

if (!isCheck) {
  console.log("All docs sections generated.");
}
