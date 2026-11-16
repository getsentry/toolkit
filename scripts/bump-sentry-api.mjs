import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Keeps one pull request that pins the workspace catalog's `@sentry/api` to
 * its newest npm release, so test.yml checks the CLI, MCP and shared packages
 * against each release. getsentry/sentry publishes the package from
 * `static/packages/api`.
 *
 * The PR's branch belongs to this script: each new release rebuilds it from
 * main. When someone has pushed their own commit to it, the script leaves the
 * branch alone and warns instead, so the commit is not lost.
 */

const PACKAGE = "@sentry/api";
const WORKSPACE = "pnpm-workspace.yaml";
const BRANCH = "bot/bump-sentry-api";
const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";

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
  return (
    execFileSync(command, args, {
      encoding: "utf8",
      timeout: 600_000,
      stdio: ["ignore", "pipe", "inherit"],
      ...options,
    })
      // execFileSync returns null when stdout is inherited.
      ?.trim()
  );
}

/**
 * What to do about the bump PR. `main` and `branch` are the versions pinned
 * on main and on the open bump PR's branch (undefined without an open PR);
 * `foreignCommits` counts the branch's commits not made by this script.
 */
export function planBump({ latest, main, branch, foreignCommits = 0 }) {
  if (main === latest) return "none";
  if (branch === undefined) return "open";
  if (branch === latest) return "none";
  return foreignCommits > 0 ? "keep" : "update";
}

/** The pinned version in pnpm-workspace.yaml `source`. */
function pinnedVersion(source) {
  return pinSentryApi(source, "0.0.0").current;
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
  ]);
  // The remote branch's commit, or empty when it does not exist. Pushing with
  // it as the lease fails if the branch moves while this runs.
  const remote = run("git", [
    "ls-remote",
    "origin",
    `refs/heads/${BRANCH}`,
  ]).split(/\s/)[0];
  let branch;
  let foreignCommits = 0;
  if (pr && remote) {
    run("git", ["fetch", "--quiet", "origin", BRANCH, "main"]);
    branch = pinnedVersion(run("git", ["show", `${remote}:${WORKSPACE}`]));
    foreignCommits = run("git", [
      "log",
      "--format=%ae",
      `origin/main..${remote}`,
    ])
      .split("\n")
      .filter((email) => email && email !== BOT_EMAIL).length;
  }

  const plan = planBump({ latest, main: current, branch, foreignCommits });
  if (plan === "none") {
    console.log(
      `${PACKAGE} ${latest} is already pinned${branch ? ` in #${pr}` : ""}.`,
    );
    return;
  }
  if (plan === "keep") {
    console.log(
      `::warning::#${pr} has commits not made by this script, so it stays on ${PACKAGE} ${branch}. Rebase it onto ${latest} by hand, or close it to let the next run open a new one.`,
    );
    return;
  }

  console.log(`Pinning ${PACKAGE} ${latest} (main has ${current}).`);
  writeFileSync(WORKSPACE, workspace);
  run("pnpm", ["install", "--lockfile-only", "--ignore-scripts"], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  const title = `chore(deps): Bump ${PACKAGE} to ${latest}`;
  const body = `Pins ${PACKAGE} to [${latest}](https://github.com/getsentry/sentry/releases/tag/api@${latest}), so CI checks this repository against the release. \`bump-sentry-api.yml\` updates this PR when a newer release ships and never merges it.`;
  run("git", ["checkout", "-B", BRANCH]);
  run("git", ["add", WORKSPACE, "pnpm-lock.yaml"]);
  run("git", ["commit", "-m", title], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: BOT_NAME,
      GIT_AUTHOR_EMAIL: BOT_EMAIL,
      GIT_COMMITTER_NAME: BOT_NAME,
      GIT_COMMITTER_EMAIL: BOT_EMAIL,
    },
  });
  // A leftover branch from a closed PR is overwritten too.
  run("git", [
    "push",
    `--force-with-lease=refs/heads/${BRANCH}:${remote}`,
    "origin",
    `HEAD:refs/heads/${BRANCH}`,
  ]);
  if (plan === "update") {
    run("gh", ["pr", "edit", pr, "--title", title, "--body", body]);
  } else {
    run("gh", [
      "pr",
      "create",
      "--head",
      BRANCH,
      "--title",
      title,
      "--body",
      body,
    ]);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
