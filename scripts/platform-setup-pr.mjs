import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Keeps one pull request with the regenerated `create_project` platform setup
 * data, for `regenerate-platform-setup.yml`. Run it from a checkout of the
 * default branch after `pnpm --filter @sentry/mcp-core run
 * generate-platform-setup`. Each change rebuilds the PR's branch from the
 * default branch and force-pushes it.
 */

const DATA_FILE =
  "packages/mcp-core/src/tools/support/project-setup/platforms.json";
const BRANCH = "bot/regenerate-platform-setup";
const TITLE = "chore(mcp-core): Regenerate create_project platform setup data";
const BODY = `Regenerates \`create_project\` platform setup data from Sentry's platform list and the published docs tree with \`pnpm --filter @sentry/mcp-core run generate-platform-setup\`.

The \`regenerate-platform-setup.yml\` workflow keeps this PR. Each run that finds new changes rebuilds this branch from main and force-pushes it, so commits pushed here by hand are lost.`;
const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

/**
 * What to do about the regeneration PR. `generated` is the freshly generated
 * data, `base` the data on the default branch, and `branch` the data on the
 * open PR's branch (undefined without an open PR).
 */
export function planRegeneration({ generated, base, branch }) {
  if (generated === base) return "none";
  if (branch === undefined) return "open";
  if (branch === generated) return "none";
  return "update";
}

function run(command, args, env = process.env) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function main() {
  const generated = readFileSync(DATA_FILE, "utf8");
  const base = run("git", ["show", `HEAD:${DATA_FILE}`]);
  const pr = run("gh", [
    "pr",
    "list",
    "--head",
    BRANCH,
    "--state",
    "open",
    "--json",
    "number",
    "--jq",
    ".[0].number // empty",
  ]).trim();
  // The remote branch's commit, or empty when it does not exist. Pushing with
  // it as the lease fails if the branch moves while this runs.
  const remote = run("git", [
    "ls-remote",
    "origin",
    `refs/heads/${BRANCH}`,
  ]).split(/\s/)[0];

  let branch;
  if (pr && remote) {
    run("git", ["fetch", "--quiet", "--depth=1", "origin", remote]);
    branch = run("git", ["show", `${remote}:${DATA_FILE}`]);
  }

  const plan = planRegeneration({ generated, base, branch });
  if (plan === "none") {
    console.log(
      `Platform setup data is unchanged${branch === undefined ? "" : ` from #${pr}`}.`,
    );
    return;
  }

  run("git", ["checkout", "-B", BRANCH]);
  run("git", ["add", DATA_FILE]);
  run("git", ["commit", "--message", TITLE], {
    ...process.env,
    GIT_AUTHOR_NAME: BOT_NAME,
    GIT_AUTHOR_EMAIL: BOT_EMAIL,
    GIT_COMMITTER_NAME: BOT_NAME,
    GIT_COMMITTER_EMAIL: BOT_EMAIL,
  });
  // A leftover branch from a closed PR is overwritten too.
  run("git", [
    "push",
    `--force-with-lease=refs/heads/${BRANCH}:${remote}`,
    "origin",
    `HEAD:refs/heads/${BRANCH}`,
  ]);
  if (plan === "update") {
    console.log(`Updated #${pr} with new platform setup data.`);
    return;
  }
  const url = run("gh", [
    "pr",
    "create",
    "--head",
    BRANCH,
    "--title",
    TITLE,
    "--body",
    BODY,
  ]).trim();
  console.log(`Opened ${url} with new platform setup data.`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
