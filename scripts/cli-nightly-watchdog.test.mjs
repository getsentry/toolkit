import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assessNightly, nightlyTimestamp } from "./cli-nightly-watchdog.mjs";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-10-16T22:30:00Z");

function run(id, status, conclusion, createdAt) {
  return {
    id,
    status,
    conclusion,
    created_at: createdAt,
    html_url: `https://github.com/getsentry/toolkit/actions/runs/${id}`,
    head_sha: `${id}`.padEnd(40, "0"),
  };
}

function expected(commitTime) {
  return { sha: "e".repeat(40), commitTime: Date.parse(commitTime) };
}

test("reads the commit timestamp stamped into nightly versions", () => {
  assert.equal(nightlyTimestamp("0.48.0-dev.1791270977"), 1791270977 * 1000);
  assert.throws(() => nightlyTimestamp("0.48.0"));
  assert.throws(() => nightlyTimestamp(undefined));
});

test("is quiet while a fresh build is publishing the newest commit", () => {
  const problems = assessNightly({
    now,
    runs: [
      run(3, "in_progress", null, "2026-10-16T22:20:00Z"),
      run(2, "completed", "success", "2026-10-16T20:00:00Z"),
    ],
    nightlyVersion: `0.48.0-dev.${Date.parse("2026-10-16T20:00:00Z") / 1000}`,
    expected: expected("2026-10-16T20:00:00Z"),
  });
  assert.deepEqual(problems, []);
});

test("flags a run parked on an environment gate and the stale nightly behind it", () => {
  // The Oct 6 outage: one darwin-arm64 job sat in `waiting` for ten days while
  // every newer main push queued behind it and was superseded.
  const problems = assessNightly({
    now,
    runs: [
      run(5, "pending", null, "2026-10-16T22:00:11Z"),
      run(4, "completed", "cancelled", "2026-10-16T20:34:09Z"),
      run(1, "waiting", null, "2026-10-06T09:14:45Z"),
    ],
    nightlyVersion: "0.48.0-dev.1791270977",
    expected: expected("2026-10-16T18:00:00Z"),
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /runs\/1\).*`waiting` since 2026-10-06/);
  assert.match(problems[1], /0\.48\.0-dev\.1791270977.*older than main/);
});

test("keeps flagging a stale nightly while fresh pushes keep arriving", () => {
  // Each new push used to restart the grace period. The commit pushed before
  // the grace period must be published regardless of what came after it.
  const problems = assessNightly({
    now,
    runs: [
      run(9, "pending", null, "2026-10-16T22:25:00Z"),
      run(8, "completed", "cancelled", "2026-10-16T21:50:00Z"),
    ],
    nightlyVersion: "0.48.0-dev.1791270977",
    expected: expected("2026-10-16T19:00:00Z"),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /older than main `eeeeeeee`/);
});

test("flags the latest finished build failing, ignoring superseded runs", () => {
  const problems = assessNightly({
    now,
    runs: [
      run(3, "completed", "cancelled", "2026-10-16T22:00:00Z"),
      run(2, "completed", "failure", "2026-10-16T21:00:00Z"),
      run(1, "completed", "success", "2026-10-16T20:00:00Z"),
    ],
    nightlyVersion: `0.48.0-dev.${Date.parse("2026-10-16T20:00:00Z") / 1000}`,
    expected: expected("2026-10-16T20:00:00Z"),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /runs\/2\).*concluded `failure`/);
});

test("treats an unreadable nightly manifest as a problem once the grace period passes", () => {
  const problems = assessNightly({
    now,
    runs: [run(1, "completed", "success", "2026-10-16T18:00:00Z")],
    nightlyVersion: "unreadable (GET ... returned 404)",
    expected: expected(new Date(now - 4 * HOUR).toISOString()),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Could not read the published nightly/);
});

test("Build jobs time out and the watchdog follows Build completions", () => {
  const build = readFileSync(
    new URL("../.github/workflows/cli-build.yml", import.meta.url),
    "utf8",
  );
  const jobs = build.split(/^jobs:\n/m)[1].split(/^ {2}(?=[a-z-]+:\n)/m);
  for (const job of jobs.filter(Boolean)) {
    assert.match(job, /^ {4}timeout-minutes: \d+$/m, job.split("\n")[0]);
  }

  const watchdog = readFileSync(
    new URL("../.github/workflows/cli-nightly-watchdog.yml", import.meta.url),
    "utf8",
  );
  assert.match(watchdog, /schedule:/);
  assert.match(watchdog, /workflows: \[Build\]/);
  assert.match(watchdog, /issues: write/);
  assert.match(watchdog, /node scripts\/cli-nightly-watchdog\.mjs/);
});
