import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../.github/workflows/migrate-cloudflare-token.yml", import.meta.url),
  "utf8",
);
const stepName = "Validate successful deployment after environment copy";
const step = workflow
  .split(`      - name: ${stepName}\n`)[1]
  ?.split("      - name: ")[0];
assert.ok(step, `Missing ${stepName} step`);
const script = step.split("        run: |\n")[1]?.replace(/^ {10}/gm, "");
assert.ok(script, `Missing ${stepName} script`);

const requiredSteps = [
  "Capture active production version",
  "Upload production version without moving traffic",
  "Identify uploaded production version",
  "Require tested revision on main before staging",
  "Stage exact candidate at zero percent",
  "Smoke test exact production Worker version",
  "Require tested revision on main before promotion",
  "Promote tested version to production",
  "Verify production deployment ownership",
  "Run Smoke Tests on Production",
];

test("required migration proof names every live deployment gate", () => {
  const deploy = readFileSync(
    new URL("../.github/workflows/deploy.yml", import.meta.url),
    "utf8",
  );
  for (const name of requiredSteps) {
    assert.equal(deploy.split(`- name: ${name}\n`).length - 1, 1, name);
  }
  for (const name of requiredSteps) {
    assert.ok(script.includes(`"${name}"`), name);
  }
});

function runValidation(jobs) {
  const directory = mkdtempSync(join(tmpdir(), "cloudflare-token-migration-"));
  try {
    writeFileSync(
      join(directory, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"secret list"*) printf '1\\n' ;;
  *"environments/production/secrets/CLOUDFLARE_API_TOKEN"*) printf '2026-10-03T14:00:00Z\\n' ;;
  *"actions/workflows/deploy.yml"*) printf '123\\n' ;;
  *"actions/runs/42/attempts/1/jobs?per_page=100"*) printf '%s\\n' "$MOCK_JOBS" ;;
  *"actions/runs/42"*) printf '123\\tworkflow_run\\tmain\\t957245447\\tcompleted\\tsuccess\\t2026-10-03T15:00:00Z\\t1\\n' ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o700 },
    );
    return spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GH_TOKEN: "dummy",
        RUN_TOKEN: "dummy",
        TARGET_REPOSITORY: "getsentry/toolkit",
        DEPLOYMENT_RUN_ID: "42",
        MOCK_JOBS: JSON.stringify(jobs),
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("rejects a successful workflow whose deploy job was skipped", () => {
  const result = runValidation({
    total_count: 1,
    jobs: [
      {
        name: "Deploy to Cloudflare",
        run_attempt: 1,
        status: "completed",
        conclusion: "skipped",
        steps: [],
      },
    ],
  });
  assert.notEqual(result.status, 0, result.stderr);
});

test("rejects a successful deploy job with skipped production smoke tests", () => {
  const result = runValidation({
    total_count: 1,
    jobs: [
      {
        name: "Deploy to Cloudflare",
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        steps: requiredSteps.map((name) => ({
          name,
          status: "completed",
          conclusion:
            name === "Run Smoke Tests on Production" ? "skipped" : "success",
        })),
      },
    ],
  });
  assert.notEqual(result.status, 0, result.stderr);
});

test("accepts a completed deployment with both smoke tests", () => {
  const result = runValidation({
    total_count: 1,
    jobs: [
      {
        name: "Deploy to Cloudflare",
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        steps: requiredSteps.map((name) => ({
          name,
          status: "completed",
          conclusion: "success",
        })),
      },
    ],
  });
  assert.equal(result.status, 0, result.stderr);
});

test("rejects missing or partial job results and a different run attempt", () => {
  const successfulJob = {
    name: "Deploy to Cloudflare",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    steps: requiredSteps.map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
    })),
  };
  for (const jobs of [
    { total_count: 0, jobs: [] },
    { total_count: 2, jobs: [successfulJob] },
    { total_count: 1, jobs: [{ ...successfulJob, run_attempt: 2 }] },
    {
      total_count: 1,
      jobs: [{ ...successfulJob, steps: successfulJob.steps.slice(0, -1) }],
    },
  ]) {
    const result = runValidation(jobs);
    assert.notEqual(result.status, 0, result.stderr);
  }
});
