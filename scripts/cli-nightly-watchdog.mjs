import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HOUR = 60 * 60 * 1000;
// A full Build run takes ~5 minutes. Anything still unfinished after this is
// stuck, for example a job parked on an environment gate nobody can approve.
export const STUCK_AFTER_MS = 2 * HOUR;
// Grace period between a built main commit and its nightly on GHCR.
export const STALE_AFTER_MS = 3 * HOUR;

const BUILD_WORKFLOW = "cli-build.yml";
const UNFINISHED = new Set([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
]);
const IGNORED_CONCLUSIONS = new Set(["cancelled", "skipped"]);

export function nightlyTimestamp(version) {
  const match = /-dev\.([1-9]\d*)$/.exec(version ?? "");
  if (!match) {
    throw new Error(`Unexpected nightly version: ${version}`);
  }
  return Number(match[1]) * 1000;
}

/**
 * Returns human-readable problems with the nightly pipeline. `runs` are Build
 * workflow push runs on main, newest first, including every unfinished run no
 * matter how old. `expected` is the newest run created before the staleness
 * grace period, with the committer time the Build stamps into its version; the
 * nightly must be at least that new, however many pushes came after it.
 */
export function assessNightly({ now, runs, nightlyVersion, expected }) {
  const problems = [];

  for (const run of runs) {
    const age = now - Date.parse(run.created_at);
    if (UNFINISHED.has(run.status) && age > STUCK_AFTER_MS) {
      problems.push(
        `Build run [${run.id}](${run.html_url}) for \`${run.head_sha.slice(0, 8)}\` has been \`${run.status}\` since ${run.created_at}. Runs share a concurrency group, so newer main builds queue behind it.`,
      );
    }
  }

  const finished = runs.find(
    (run) =>
      run.status === "completed" && !IGNORED_CONCLUSIONS.has(run.conclusion),
  );
  if (finished && finished.conclusion !== "success") {
    problems.push(
      `The latest finished Build run [${finished.id}](${finished.html_url}) for \`${finished.head_sha.slice(0, 8)}\` concluded \`${finished.conclusion}\`.`,
    );
  }

  if (expected) {
    let published;
    try {
      published = nightlyTimestamp(nightlyVersion);
    } catch (error) {
      problems.push(`Could not read the published nightly: ${error.message}`);
    }
    if (published !== undefined && published < expected.commitTime) {
      problems.push(
        `GHCR \`nightly\` is \`${nightlyVersion}\` (${new Date(published).toISOString()}), older than main \`${expected.sha.slice(0, 8)}\` committed at ${new Date(expected.commitTime).toISOString()}.`,
      );
    }
  }

  return problems;
}

async function getJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return response.json();
}

async function readNightlyVersion(repository) {
  try {
    const { token } = await getJson(
      `https://ghcr.io/token?scope=repository:${repository}:pull`,
    );
    const manifest = await getJson(
      `https://ghcr.io/v2/${repository}/manifests/nightly`,
      {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.oci.image.manifest.v1+json",
      },
    );
    return manifest.annotations?.version;
  } catch (error) {
    return `unreadable (${error.message})`;
  }
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
  }
  const reportIndex = process.argv.indexOf("--report");
  const reportPath = reportIndex === -1 ? null : process.argv[reportIndex + 1];

  const api = `https://api.github.com/repos/${repository}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const listRuns = async (query) =>
    (
      await getJson(
        `${api}/actions/workflows/${BUILD_WORKFLOW}/runs?branch=main&event=push&${query}`,
        headers,
      )
    ).workflow_runs;
  const now = Date.now();

  // A stuck run is the oldest one, so query unfinished runs by status rather
  // than relying on them still being on the first page of recent runs.
  const byId = new Map();
  for (const batch of await Promise.all([
    listRuns("per_page=50"),
    ...[...UNFINISHED].map((status) =>
      listRuns(`status=${status}&per_page=100`),
    ),
  ])) {
    for (const run of batch) {
      byId.set(run.id, run);
    }
  }
  const runs = [...byId.values()].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  );

  const cutoff = new Date(now - STALE_AFTER_MS).toISOString();
  const [reference] = await listRuns(
    `created=${encodeURIComponent(`<${cutoff}`)}&per_page=1`,
  );
  let expected = null;
  if (reference) {
    const commit = await getJson(
      `${api}/commits/${reference.head_sha}`,
      headers,
    );
    expected = {
      sha: reference.head_sha,
      commitTime: Date.parse(commit.commit.committer.date),
    };
  }

  const nightlyVersion = await readNightlyVersion(repository);
  const problems = assessNightly({ now, runs, nightlyVersion, expected });

  const report = [
    problems.length === 0
      ? "CLI nightly publishing is healthy."
      : [
          "CLI nightly publishing needs attention:",
          "",
          ...problems.map((problem) => `- ${problem}`),
        ].join("\n"),
    `Published nightly: \`${nightlyVersion}\``,
    ...(problems.length === 0
      ? []
      : [
          "Cancel a stuck Build run to let the newest queued main build proceed, or rerun a failed one. This issue closes automatically once the nightly catches up.",
        ]),
  ].join("\n\n");
  console.log(report);
  if (reportPath) {
    writeFileSync(reportPath, `${report}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `healthy=${problems.length === 0}\n`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
