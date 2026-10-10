import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const docs = readFileSync(
  new URL("../src/content/docs/migrating-from-v3.md", import.meta.url),
  "utf8",
);
const shim = docs.match(/```bash\n(sentry-cli\(\) \{[\s\S]*?\n\})\n```/)?.[1];
assert.ok(shim, "the migration guide must contain its runnable Bash shim");

function runShim(args, extraEnv = {}, parentEnv = process.env, shell = "bash") {
  const directory = mkdtempSync(join(tmpdir(), "sentry-migration-shim-"));
  try {
    writeFileSync(join(directory, "sentry"), `#!/bin/sh
printf '%s\\n' "$@"
if [ "\${SENTRY_TEST_SHIM_ENV:-}" = 1 ]; then
  printf 'auth=%s\\nheaders=%s\\nhost=%s\\n' "\${SENTRY_AUTH_TOKEN:-}" "\${SENTRY_CUSTOM_HEADERS:-}" "\${SENTRY_HOST:-}"
fi
exit "\${SENTRY_TEST_SHIM_EXIT:-0}"
`, { mode: 0o700 });
    return spawnSync(shell, ["-c", `${shim}\nsentry-cli "$@"`, "--", ...args], {
      encoding: "utf8",
      env: {
        ...parentEnv,
        SENTRY_AUTH_TOKEN: "",
        SENTRY_CUSTOM_HEADERS: "",
        SENTRY_HOST: "",
        SENTRY_URL: "",
        SENTRY_FORCE_ENV_TOKEN: "",
        PATH: `${directory}:${parentEnv.PATH}`,
        SENTRY_ALLOW_FAILURE: "",
        ...extraEnv,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [name, args, expected] of [
  ["release creation after --org", ["releases", "--org", "acme", "new", "1.0.0"], ["--org", "acme", "release", "new", "1.0.0"]],
  ["bare release list after --org", ["releases", "--org", "acme"], ["--org", "acme", "release", "list"]],
  ["nested deploys after --org", ["releases", "--org", "acme", "deploys", "-r", "1.0.0"], ["--org", "acme", "release", "deploys", "1.0.0"]],
  ["issue resolution after --org", ["issues", "--org", "acme", "resolve", "ISSUE-1"], ["--org", "acme", "issue", "resolve", "ISSUE-1"]],
  ["bare project list after --project", ["projects", "--project", "demo"], ["--project", "demo", "project", "list"]],
  ["release creation without group flags", ["releases", "new", "1.0.0"], ["release", "new", "1.0.0"]],
]) {
  test(name, () => {
    const result = runShim(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), expected);
  });
}

test("translates trailing auth and headers and honors allow-failure", () => {
  const result = runShim(
    ["releases", "new", "1.0.0", "--auth-token", "example-token", "--header", "X-Test: 1", "--allow-failure"],
    { SENTRY_TEST_SHIM_ENV: "1", SENTRY_TEST_SHIM_EXIT: "23" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "release", "new", "1.0.0", "auth=example-token", "headers=X-Test: 1", "host=",
  ]);
});

test("translates trailing host URL but preserves release URL", () => {
  const issue = runShim(["issues", "--url", "https://sentry.example.com", "list"], { SENTRY_TEST_SHIM_ENV: "1" });
  assert.equal(issue.status, 0, issue.stderr);
  assert.deepEqual(issue.stdout.trim().split("\n"), ["issue", "list", "auth=", "headers=", "host=https://sentry.example.com"]);

  const release = runShim(["releases", "new", "1.0.0", "--url", "https://release.example.com"], { SENTRY_TEST_SHIM_ENV: "1" });
  assert.equal(release.status, 0, release.stderr);
  assert.deepEqual(release.stdout.trim().split("\n"), ["release", "new", "1.0.0", "--url", "https://release.example.com", "auth=", "headers=", "host="]);
});

test("releases maps a host URL before the subcommand without losing its release URL", () => {
  for (const urlFlag of [
    ["--url", "https://sentry.example.com"],
    ["--url=https://sentry.example.com"],
  ]) {
    const result = runShim([
      "releases", "--org", "acme", ...urlFlag, "new", "1.0.0", "--url", "https://release.example.com",
    ], { SENTRY_TEST_SHIM_ENV: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "--org", "acme", "release", "new", "1.0.0", "--url", "https://release.example.com",
      "auth=", "headers=", "host=https://sentry.example.com",
    ]);
  }

  const overridden = runShim([
    "--url", "https://old.example.com", "releases", "--url", "https://sentry.example.com", "list",
  ], { SENTRY_TEST_SHIM_ENV: "1" });
  assert.equal(overridden.status, 0, overridden.stderr);
  assert.match(overridden.stdout, /host=https:\/\/sentry\.example\.com/);
});

test("deploys and nested release deploys map host URLs before the subcommand", () => {
  for (const args of [
    ["deploys", "--url", "https://sentry.example.com", "list"],
    ["releases", "deploys", "--url=https://sentry.example.com", "list"],
  ]) {
    const result = runShim(args, { SENTRY_TEST_SHIM_ENV: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "release", "deploys", "auth=", "headers=", "host=https://sentry.example.com",
    ]);
  }
});

test("a release named new is a value, not the deploy-create subcommand", () => {
  for (const [args, expected] of [
    [["deploys", "list", "-r", "new"], ["release", "deploys", "new"]],
    [["releases", "deploys", "--release=new"], ["release", "deploys", "new"]],
  ]) {
    const result = runShim(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), expected);
  }

  for (const args of [["deploys", "new", "-r", "1.0.0"], ["deploys", "-r", "1.0.0", "new"]]) {
    const result = runShim(args);
    assert.equal(result.status, 64);
    assert.match(result.stderr, /deploys new.*changed in v4/);
  }
});

test("zsh inserts a group host before the sentry executable", {
  skip: spawnSync("zsh", ["-c", "exit 0"]).error ? "zsh is unavailable" : false,
}, () => {
  const result = runShim(
    ["releases", "--url", "https://sentry.example.com", "new", "1.0.0"],
    { SENTRY_TEST_SHIM_ENV: "1" }, process.env, "zsh",
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "release", "new", "1.0.0", "auth=", "headers=", "host=https://sentry.example.com",
  ]);

  const groupFlag = runShim(
    ["--org", "sentry", "releases", "--url", "https://sentry.example.com", "list"],
    { SENTRY_TEST_SHIM_ENV: "1" }, process.env, "zsh",
  );
  assert.equal(groupFlag.status, 0, groupFlag.stderr);
  assert.deepEqual(groupFlag.stdout.trim().split("\n"), [
    "--org", "sentry", "release", "list", "auth=", "headers=", "host=https://sentry.example.com",
  ]);
});

test("login retains the URL before or after the command", () => {
  for (const args of [
    ["--url", "https://sentry.example.com", "login"],
    ["login", "--url", "https://sentry.example.com"],
  ]) {
    const result = runShim(args, { SENTRY_TEST_SHIM_ENV: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "auth", "login", "--url", "https://sentry.example.com", "auth=", "headers=", "host=",
    ]);
  }
});

test("the stub never inherits credentials or host settings from the test process", () => {
  const result = runShim(
    ["login"],
    { SENTRY_TEST_SHIM_ENV: "1" },
    {
      ...process.env,
      SENTRY_AUTH_TOKEN: "inherited-token",
      SENTRY_CUSTOM_HEADERS: "inherited-header",
      SENTRY_HOST: "https://old.example.com",
      SENTRY_URL: "https://old.example.com",
      SENTRY_FORCE_ENV_TOKEN: "1",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [
    "auth", "login", "auth=", "headers=", "host=",
  ]);
});

test("send-envelope never silently invokes a different command", () => {
  const result = runShim(["send-envelope", "./envelope-file"]);
  assert.equal(result.status, 64);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /event send <envelope-file> --raw/);
});
