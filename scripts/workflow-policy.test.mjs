import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Every workflow that runs on pull requests, and why `test.yml` cannot run its
// checks. Package-specific checks (build, test, E2E, packed-tarball checks)
// belong in `package.json#sentryCi`, so `test.yml` runs them in its
// per-project matrix. See docs/operations/github-actions.md#package-ci-checks.
const PULL_REQUEST_WORKFLOWS = new Map([
  ["test.yml", "Builds and runs the per-project matrix."],
  ["eval.yml", "Runs AI evaluations against model providers."],
  [
    "install-scripts.yml",
    "Installs the latest published CLI release on macOS and Windows.",
  ],
  ["local.yml", "Runs Sentry Local E2E tests on Linux, macOS, and Windows."],
  ["pr-risk-jev.yml", "Labels pull requests by risk."],
  ["pr-risk-labels-test.yml", "Tests the PR risk label publisher script."],
  [
    "smoke-tests.yml",
    "Starts the MCP Worker and publishes a smoke-test report.",
  ],
  ["token-cost.yml", "Reports MCP tool token costs against main."],
]);

const PULL_REQUEST_EVENTS = [
  "pull_request",
  "pull_request_target",
  "merge_group",
];

const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);

/** Return the text of a workflow's top-level `on` trigger. */
function workflowTriggers(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^["']?on["']?:/.test(line));
  if (start === -1) {
    return "";
  }
  const end = lines.findIndex(
    (line, index) => index > start && /^[^\s#]/.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function runsOnPullRequests(source) {
  const triggers = workflowTriggers(source);
  return PULL_REQUEST_EVENTS.some((event) =>
    new RegExp(`(?:^|[\\s\\[,])${event}(?=[\\s:,\\]]|$)`, "m").test(triggers),
  );
}

describe("workflow policy", () => {
  it("detects pull request triggers in every YAML form", () => {
    assert.equal(runsOnPullRequests("on: pull_request\n"), true);
    assert.equal(runsOnPullRequests("on: [push, pull_request]\n"), true);
    assert.equal(
      runsOnPullRequests("on:\n  pull_request:\n    paths: [a]\njobs:\n"),
      true,
    );
    assert.equal(runsOnPullRequests("on:\n  merge_group:\njobs:\n"), true);
    assert.equal(
      runsOnPullRequests("on:\n  pull_request_target:\n    types: [opened]\n"),
      true,
    );
    assert.equal(
      runsOnPullRequests(
        "on:\n  push:\n    branches: [main]\njobs:\n  pull_request:\n",
      ),
      false,
    );
    assert.equal(
      runsOnPullRequests("on:\n  workflow_run:\n    workflows: [Test]\n"),
      false,
    );
  });

  it("keeps package checks in the test.yml matrix", () => {
    const workflows = readdirSync(workflowsDirectory).filter((file) =>
      /\.ya?ml$/.test(file),
    );
    const pullRequestWorkflows = workflows.filter((file) =>
      runsOnPullRequests(
        readFileSync(new URL(file, workflowsDirectory), "utf8"),
      ),
    );

    for (const file of pullRequestWorkflows) {
      assert.ok(
        PULL_REQUEST_WORKFLOWS.has(file),
        `.github/workflows/${file} runs on pull requests. Put package-specific checks in package.json#sentryCi so test.yml runs them (see docs/operations/github-actions.md#package-ci-checks). If the matrix cannot run this workflow, add it with the reason to PULL_REQUEST_WORKFLOWS in scripts/workflow-policy.test.mjs.`,
      );
    }
    for (const file of PULL_REQUEST_WORKFLOWS.keys()) {
      assert.ok(
        pullRequestWorkflows.includes(file),
        `Remove ${file} from PULL_REQUEST_WORKFLOWS; it no longer runs on pull requests.`,
      );
    }
  });
});
