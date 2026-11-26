import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

/**
 * Posts or updates the token cost report comment for `token-cost.yml`.
 *
 * The workflow runs on any lockfile change, so most runs measure the same MCP
 * surface as main. It comments only when the tool definitions or the MCP Apps
 * views differ from main's last artifact, and keeps an existing comment up to
 * date so it never shows stale numbers.
 */

const MARKER = "📊 MCP Server Token Cost Report";
const REPORT_FILE = "packages/mcp-core/token-report.md";
const STATS_FILES = ["token-stats.json", "ui-stats.json"];
const CURRENT_DIR = "packages/mcp-core";
const MAIN_DIR = "main-stats";
const ARTIFACT_PREFIX = "token-stats-";

/** Runs `read`, or returns undefined when the path does not exist. */
function ifExists(read) {
  try {
    return read();
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function readJson(file) {
  return ifExists(() => JSON.parse(readFileSync(file, "utf8")));
}

function readStats(dir) {
  return STATS_FILES.map((name) => readJson(`${dir}/${name}`));
}

/**
 * Reads main's stats, or returns undefined when its artifact is missing. The
 * download step matches the artifact name by regex, so it unpacks the artifact
 * into `main-stats/token-stats-<sha>/`.
 */
function readMainStats() {
  const entries = ifExists(() =>
    readdirSync(MAIN_DIR, { withFileTypes: true }),
  );
  const artifacts = (entries ?? []).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith(ARTIFACT_PREFIX),
  );
  if (artifacts.length !== 1) return undefined;
  return readStats(`${MAIN_DIR}/${artifacts[0].name}`);
}

/**
 * What to do with the PR comment. `current` and `main` hold the parsed stats
 * files in `STATS_FILES` order; `main` is undefined when main's artifact could
 * not be downloaded.
 */
export function planComment({ current, main, existingCommentId }) {
  if (existingCommentId !== undefined) return "update";
  if (main === undefined || main[0] === undefined) return "none";
  return isDeepStrictEqual(current, main) ? "none" : "create";
}

export async function upsertTokenCostComment({ github, context, core }) {
  const { owner, repo } = context.repo;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: context.issue.number,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) => comment.user?.type === "Bot" && comment.body?.includes(MARKER),
  );

  const plan = planComment({
    current: readStats(CURRENT_DIR),
    main: readMainStats(),
    existingCommentId: existing?.id,
  });

  if (plan === "none") {
    core.info("Token cost and MCP Apps views match main; not commenting.");
    return;
  }

  const body = readFileSync(REPORT_FILE, "utf8");
  if (plan === "update") {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    core.info(`Updated token cost comment ${existing.id}.`);
    return;
  }

  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: context.issue.number,
    body,
  });
  core.info("Created token cost comment.");
}
