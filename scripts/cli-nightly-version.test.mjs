import assert from "node:assert/strict";
import test from "node:test";
import { computeNightlyVersion } from "./cli-nightly-version.mjs";

test("stamps development and release versions with the same commit timestamp", () => {
  assert.equal(
    computeNightlyVersion("0.47.0-dev.0", "1791028800"),
    "0.47.0-dev.1791028800",
  );
  assert.equal(
    computeNightlyVersion("0.47.0", "1791028800"),
    "0.47.0-dev.1791028800",
  );
});

test("rejects invalid inputs before they can become OCI tags", () => {
  for (const [version, timestamp] of [
    ["0.47.0-dev.bad", "1791028800"],
    ["0.47.0-rc.1", "1791028800"],
    ["0.47.0", "0"],
    ["0.47.0", "1791028800\nmalicious"],
    ["0.47.0", "9007199254740992"],
  ]) {
    assert.throws(() => computeNightlyVersion(version, timestamp));
  }
});
