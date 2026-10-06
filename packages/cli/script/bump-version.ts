#!/usr/bin/env node
/**
 * Version Bump Script
 *
 * Handles version bumping for releases, keeping package.json and plugin.json in sync.
 * Extracted from .craft.yml inline scripts for maintainability.
 *
 * Usage:
 *   node --experimental-strip-types script/bump-version.ts --pre   # Pre-release: set CRAFT_NEW_VERSION
 *   node --experimental-strip-types script/bump-version.ts --post  # Post-release: bump to next dev version
 *
 * Pre-release (--pre):
 *   - Sets package.json version to CRAFT_NEW_VERSION
 *   - Updates plugin.json version (strips prerelease suffix)
 *
 * Post-release (--post):
 *   - Bumps package.json to next preminor with -dev prerelease
 *   - Updates plugin.json version
 *   - Commits and pushes if there are changes
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PLUGIN_PATH = "plugins/sentry-cli/.claude-plugin/plugin.json";

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

/**
 * Execute a shell command with output inherited to stdout/stderr
 */
function exec(command: string): void {
  execSync(command, { stdio: "inherit" });
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

  // Update plugin.json (strip prerelease suffix for cleaner version)
  const plugin = readPluginJson();
  plugin.version = stripPrerelease(version);
  writePluginJson(plugin);

  console.log(`Updated plugin.json to ${plugin.version}`);
}

/**
 * Post-release: Bump to next dev version, commit and push
 */
function postRelease(): void {
  console.log("Bumping to next development version");

  // Bump package.json to next preminor with -dev prerelease
  exec("npm --no-git-tag-version version preminor --preid=dev");

  // Read the new version from package.json
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
    version: string;
  };
  console.log(`package.json bumped to ${pkg.version}`);

  // Update plugin.json
  const plugin = readPluginJson();
  plugin.version = stripPrerelease(pkg.version);
  writePluginJson(plugin);
  console.log(`Updated plugin.json to ${plugin.version}`);

  // Commit and push if there are changes
  // Use spawnSync to check exit code without throwing
  const diffResult = spawnSync("git", ["diff", "--quiet"], {
    stdio: "inherit",
  });
  if (diffResult.status !== 0) {
    console.log("Committing version bump");
    exec(
      'git commit -anm "meta: Bump new development version\n\n#skip-changelog"'
    );
    exec("git pull --rebase");
    exec("git push");
    console.log("Pushed version bump");
  } else {
    console.log("No changes to commit");
  }
}

/**
 * Print usage information
 */
function printUsage(): void {
  console.log(`
Usage: node --experimental-strip-types script/bump-version.ts <mode>

Modes:
  --pre   Pre-release: set version from CRAFT_NEW_VERSION env var
  --post  Post-release: bump to next dev version, commit and push

Examples:
  CRAFT_NEW_VERSION=1.0.0 node --experimental-strip-types script/bump-version.ts --pre
  node --experimental-strip-types script/bump-version.ts --post
`);
}

// Main
const args = process.argv.slice(2);

function parseMode(): "pre" | "post" | null {
  if (args.includes("--pre")) {
    return "pre";
  }
  if (args.includes("--post")) {
    return "post";
  }
  return null;
}

const mode = parseMode();

if (!mode) {
  printUsage();
  process.exit(1);
}

if (mode === "pre") {
  preRelease();
} else {
  postRelease();
}
