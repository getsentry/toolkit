#!/usr/bin/env node
/**
 * Version Bump Script
 *
 * Craft's `preReleaseCommand` for the CLI workspace. It runs for the release
 * version in `craft prepare`, and again for the next `-dev` version after
 * `craft publish` (`postReleaseBump` in .craft.yml), which Craft commits and
 * pushes. `@sentry/mcp-server` ships with every CLI release, so it takes the
 * same version.
 *
 * Usage:
 *   CRAFT_NEW_VERSION=1.0.0 node --experimental-strip-types script/bump-version.ts --pre
 *
 * Sets CRAFT_NEW_VERSION as:
 *   - the CLI and @sentry/mcp-server package.json versions
 *   - the plugin.json version, without the prerelease suffix
 *   - the tracked CLI skill frontmatter versions
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_PATH = "plugins/sentry-cli/.claude-plugin/plugin.json";
const MCP_SERVER_PATH = "../mcp-server";
const SKILL_PATH = "plugins/sentry-cli/skills/sentry-cli";
const SKILL_VERSION_LINE = /^version: [^\r\n]+$/gm;

/** Regex to match prerelease suffix (e.g., -dev.0, -alpha.1) */
const PRERELEASE_SUFFIX_REGEX = /-.*$/;

type PluginJson = {
  version: string;
  [key: string]: unknown;
};

/**
 * Read and parse plugin.json
 */
function readPluginJson(): PluginJson {
  return JSON.parse(readFileSync(PLUGIN_PATH, "utf-8")) as PluginJson;
}

/**
 * Write plugin.json with consistent formatting
 */
function writePluginJson(plugin: PluginJson): void {
  writeFileSync(PLUGIN_PATH, `${JSON.stringify(plugin, null, 2)}\n`);
}

/**
 * Strip prerelease suffix from version string.
 * "1.0.0-dev.0" → "1.0.0"
 * "1.0.0" → "1.0.0"
 */
function stripPrerelease(version: string): string {
  return version.replace(PRERELEASE_SUFFIX_REGEX, "");
}

/** Update the tracked skill frontmatter without requiring a network-backed schema build. */
function syncSkillVersions(version: string): void {
  const references = readdirSync(join(SKILL_PATH, "references"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(SKILL_PATH, "references", name));
  if (references.length === 0) {
    throw new Error("Generated CLI skill references are missing");
  }

  const files = [join(SKILL_PATH, "SKILL.md"), ...references].map((path) => {
    const content = readFileSync(path, "utf-8");
    const end = content.indexOf("\n---\n", 4);
    if (!content.startsWith("---\n") || end === -1) {
      throw new Error(`Invalid CLI skill frontmatter: ${path}`);
    }
    const frontmatter = content.slice(0, end);
    const versions = frontmatter.match(SKILL_VERSION_LINE);
    if (versions?.length !== 1) {
      throw new Error(`Expected one CLI skill version: ${path}`);
    }
    return {
      path,
      content:
        frontmatter.replace(SKILL_VERSION_LINE, `version: ${version}`) +
        content.slice(end),
    };
  });

  for (const { path, content } of files) {
    writeFileSync(path, content);
  }
}

/**
 * Execute a shell command with output inherited to stdout/stderr
 */
function exec(command: string, cwd?: string): void {
  execSync(command, { stdio: "inherit", cwd });
}

/** Give `@sentry/mcp-server` the CLI's version. */
function setMcpServerVersion(version: string): void {
  exec(
    `npm --no-git-tag-version --allow-same-version version ${version}`,
    MCP_SERVER_PATH,
  );
  console.log(`Updated @sentry/mcp-server to ${version}`);
}

/**
 * Pre-release: Set version from CRAFT_NEW_VERSION environment variable
 */
function preRelease(): void {
  const version = process.env.CRAFT_NEW_VERSION;
  if (!version) {
    console.error("Error: CRAFT_NEW_VERSION environment variable is required");
    process.exit(1);
  }

  console.log(`Setting version to ${version}`);

  // Update package.json via npm (handles formatting consistently)
  exec(`npm --no-git-tag-version version ${version}`);
  setMcpServerVersion(version);

  // Update plugin.json (strip prerelease suffix for cleaner version)
  const plugin = readPluginJson();
  plugin.version = stripPrerelease(version);
  writePluginJson(plugin);

  console.log(`Updated plugin.json to ${plugin.version}`);

  // The generator embeds package.json's version in every tracked skill file.
  // Sync only its frontmatter here: the full generator needs an API schema that
  // is gitignored and may not exist in Craft's checkout.
  syncSkillVersions(version);
}

if (process.argv.includes("--pre")) {
  preRelease();
} else {
  console.log(`
Usage: CRAFT_NEW_VERSION=<version> node --experimental-strip-types script/bump-version.ts --pre
`);
  process.exit(1);
}
