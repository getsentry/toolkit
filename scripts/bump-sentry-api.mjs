import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Pins the workspace catalog's `@sentry/api` to its newest npm release and
 * opens a pull request for it, so test.yml checks the CLI, MCP and shared
 * packages against each release. getsentry/sentry publishes the package from
 * `static/packages/api`.
 */

const PACKAGE = "@sentry/api";
const WORKSPACE = "pnpm-workspace.yaml";

const CATALOG_ENTRY = /^(\s+"@sentry\/api":\s*)(\S+)\s*$/m;
const RELEASE_AGE_ENTRY = /^(\s+-\s*"@sentry\/api@)([^"]+)("\s*)$/m;

/**
 * Return pnpm-workspace.yaml with `@sentry/api` pinned to `version`, in the
 * catalog and in `minimumReleaseAgeExclude`, which lets a fresh release
 * install. Throws when either entry is missing.
 */
export function pinSentryApi(workspace, version) {
  for (const [pattern, name] of [
    [CATALOG_ENTRY, "catalog"],
    [RELEASE_AGE_ENTRY, "minimumReleaseAgeExclude"],
  ]) {
    const count = workspace.match(new RegExp(pattern.source, "gm"))?.length;
    if (count !== 1) {
      throw new Error(
        `${WORKSPACE} needs one ${name} entry for ${PACKAGE}, found ${count ?? 0}`,
      );
    }
  }
  const catalog = CATALOG_ENTRY.exec(workspace);
  return {
    current: catalog[2],
    workspace: workspace
      .replace(CATALOG_ENTRY, (_, key) => `${key}${version}`)
      .replace(
        RELEASE_AGE_ENTRY,
        (_, start, _old, end) => `${start}${version}${end}`,
      ),
  };
}

/** Whether `version` is a stable release, such as 2.5.1. */
export function isRelease(version) {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 600_000,
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();
}

function main() {
  const latest = run("npm", ["view", PACKAGE, "version"]);
  if (!isRelease(latest)) {
    throw new Error(`Expected a release version of ${PACKAGE}, got: ${latest}`);
  }
  const { current, workspace } = pinSentryApi(
    readFileSync(WORKSPACE, "utf8"),
    latest,
  );
  if (current === latest) {
    console.log(`${PACKAGE} is already ${latest}.`);
    return;
  }
  console.log(`Bumping ${PACKAGE} from ${current} to ${latest}.`);
  writeFileSync(WORKSPACE, workspace);
  run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  // A run that stopped before opening the PR leaves the branch behind, so
  // overwrite it and reuse an open PR.
  const branch = `bot/bump-sentry-api-to-${latest}`;
  const title = `chore(deps): Bump ${PACKAGE} to ${latest}`;
  run("git", ["checkout", "-B", branch]);
  run("git", ["add", WORKSPACE, "pnpm-lock.yaml"]);
  run("git", [
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit",
    "-m",
    title,
  ]);
  run("git", ["push", "--force", "--set-upstream", "origin", branch]);
  const open = run("gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    "length",
  ]);
  if (open === "0") {
    run("gh", [
      "pr",
      "create",
      "--head",
      branch,
      "--title",
      title,
      "--body",
      `Pins ${PACKAGE} to [${latest}](https://github.com/getsentry/sentry/releases/tag/api@${latest}), so CI checks this repository against the release.`,
    ]);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
