import assert from "node:assert/strict";
import test from "node:test";
import { isDecisive } from "./mcp-deploy-watchdog.mjs";

function run(conclusion, failedSteps = [], status = "completed") {
  return { status, conclusion, failedSteps };
}

test("successful and failed deployments decide health", () => {
  assert.equal(isDecisive(run("success")), true);
  assert.equal(
    isDecisive(run("failure", ["Capture active production version"])),
    true,
  );
  assert.equal(
    isDecisive(
      run("failure", [
        "Stage exact candidate at zero percent",
        "Require tested revision on main before promotion",
      ]),
    ),
    true,
  );
});

test("superseded, skipped, cancelled, and unfinished runs are ignored", () => {
  for (const step of [
    "Require tested revision on main",
    "Require tested revision on main before staging",
    "Require tested revision on main before promotion",
  ]) {
    assert.equal(isDecisive(run("failure", [step])), false, step);
  }
  assert.equal(isDecisive(run("skipped")), false);
  assert.equal(isDecisive(run("cancelled")), false);
  assert.equal(isDecisive(run(null, [], "in_progress")), false);
});
