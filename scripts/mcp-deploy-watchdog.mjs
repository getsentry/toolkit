import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEPLOY_WORKFLOW = "deploy.yml";
// These steps refuse a revision once main has moved on. A newer run deploys
// the newer commit, so the refusal is not a deployment failure.
const SUPERSEDED_STEP = /^Require tested revision on main\b/;
const IGNORED_CONCLUSIONS = new Set(["cancelled", "skipped"]);

/**
 * Whether a deploy run reflects production deployment health. `failedSteps`
 * holds the names of the run's failed job steps.
 */
export function isDecisive(run) {
  return (
    run.status === "completed" &&
    !IGNORED_CONCLUSIONS.has(run.conclusion) &&
    !(
      run.conclusion === "failure" &&
      run.failedSteps.length > 0 &&
      run.failedSteps.every((step) => SUPERSEDED_STEP.test(step))
    )
  );
}

async function getJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return await response.json();
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
  const { workflow_runs: listed } = await getJson(
    `${api}/actions/workflows/${DEPLOY_WORKFLOW}/runs?branch=main&per_page=30`,
    headers,
  );
  // Runs are newest first; the first decisive one is the current state.
  let decisive = null;
  for (const run of listed) {
    let failedSteps = [];
    if (run.conclusion === "failure") {
      const { jobs } = await getJson(
        `${api}/actions/runs/${run.id}/jobs?per_page=100`,
        headers,
      );
      failedSteps = jobs.flatMap((job) =>
        (job.steps ?? [])
          .filter((step) => step.conclusion === "failure")
          .map((step) => step.name),
      );
    }
    if (isDecisive({ ...run, failedSteps })) {
      decisive = { ...run, failedSteps };
      break;
    }
  }

  const healthy = !decisive || decisive.conclusion === "success";
  const report = healthy
    ? "MCP production deployments are healthy."
    : [
        "MCP production deployments are failing.",
        `The latest deploy run [${decisive.id}](${decisive.html_url}) for \`${decisive.head_sha.slice(0, 8)}\` concluded \`${decisive.conclusion}\`${decisive.failedSteps.length > 0 ? ` at ${decisive.failedSteps.map((step) => `\`${step}\``).join(", ")}` : ""}.`,
        "Check the run log and Cloudflare deployment state. If a stage or promotion was left behind, run `recover-cloudflare-deployment.yml` with that run's ID and attempt. This issue closes automatically after the next successful deployment.",
      ].join("\n\n");
  console.log(report);
  if (reportPath) {
    writeFileSync(reportPath, `${report}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `healthy=${healthy}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
