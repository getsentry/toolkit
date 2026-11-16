import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isRelease, pinSentryApi } from "./bump-sentry-api.mjs";

const workspace = readFileSync(
  new URL("../pnpm-workspace.yaml", import.meta.url),
  "utf8",
);

test("pins the catalog and the release-age exclusion together", () => {
  const { current, workspace: pinned } = pinSentryApi(workspace, "9.8.7");
  assert.match(current, /^\d+\.\d+\.\d+$/);
  assert.match(pinned, /^ {2}"@sentry\/api": 9\.8\.7$/m);
  assert.match(pinned, /^ {2}- "@sentry\/api@9\.8\.7"$/m);
  assert.equal(pinned.split("9.8.7").length - 1, 2);
  // Nothing else changes.
  assert.equal(pinned.replaceAll("9.8.7", current), workspace);
});

test("fails when an entry is missing or repeated", () => {
  const withoutExclusion = workspace.replace(/^ +- "@sentry\/api@.*\n/m, "");
  assert.throws(
    () => pinSentryApi(withoutExclusion, "9.8.7"),
    /minimumReleaseAgeExclude/,
  );
  const repeated = workspace.replace(/^( +"@sentry\/api": .*\n)/m, "$1$1");
  assert.throws(() => pinSentryApi(repeated, "9.8.7"), /found 2/);
});

test("accepts only stable releases", () => {
  assert.equal(isRelease("2.5.1"), true);
  assert.equal(isRelease("3.0.0-rc.0"), false);
  assert.equal(isRelease(""), false);
});
