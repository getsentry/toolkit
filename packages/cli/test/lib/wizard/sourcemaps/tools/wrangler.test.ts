import {
  DIST_DIR,
  findOutDir,
  getSentryCliCommand,
  getWranglerDeployCommand,
  safeInsertArgsToWranglerDeployCommand,
} from "../../../../../src/lib/wizard/sourcemaps/tools/wrangler.js";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

describe("getSentryCliCommand", () => {
  it.each([
    "wrangler deploy --outdir 'dist$(printf${IFS}INJECTED)'",
    "wrangler deploy --outdir='dist$(printf${IFS}INJECTED)'",
    "wrangler deploy --outdir dist",
  ])("passes the directory from %s literally to sentry", (deployCommand) => {
    const outDir = findOutDir(deployCommand);
    const command = getSentryCliCommand({
      selfHosted: false,
      orgSlug: "myOrg",
      projectSlug: "myProject",
      url: "https://sentry.io",
      authToken: "_ignore",
      outDir,
    });

    expect(runSentryCliCommand(command)).toEqual([
      "release",
      "create",
      "release with spaces",
      "--org=myOrg",
      "--project=myProject",
      "sourcemap",
      "upload",
      "--org=myOrg",
      "--project=myProject",
      "--release=release with spaces",
      "--no-rewrite",
      outDir,
    ]);
  });

  it("preserves quotes and shell syntax in paths and self-hosted arguments", () => {
    const outDir = "worker's dist;$(printf${IFS}INJECTED)";
    const url = "https://sentry.example/worker's";
    const orgSlug = "org$(printf${IFS}INJECTED)";
    const projectSlug = "project`printf INJECTED`";
    const command = getSentryCliCommand({
      selfHosted: true,
      url,
      orgSlug,
      projectSlug,
      authToken: "_ignore",
      outDir,
    });

    expect(runSentryCliCommand(command)).toEqual([
      `SENTRY_URL=${url}`,
      "release",
      "create",
      "release with spaces",
      `--org=${orgSlug}`,
      `--project=${projectSlug}`,
      `SENTRY_URL=${url}`,
      "sourcemap",
      "upload",
      `--org=${orgSlug}`,
      `--project=${projectSlug}`,
      "--release=release with spaces",
      "--no-rewrite",
      outDir,
    ]);
  });

  it("returns correct command for SaaS", () => {
    const command = getSentryCliCommand({
      selfHosted: false,
      orgSlug: "myOrg",
      projectSlug: "myProject",
      url: "https://sentry.io",
      authToken: "_ignore",
      outDir: "dist",
    });

    expect(command).toBe(
      "_SENTRY_RELEASE=$(sentry release propose-version | head -n 1) && sentry release create \"$_SENTRY_RELEASE\" --org='myOrg' --project='myProject' && sentry sourcemap upload --org='myOrg' --project='myProject' --release=\"$_SENTRY_RELEASE\" --no-rewrite 'dist'",
    );
  });

  it("returns correct command for self-hosted", () => {
    const command = getSentryCliCommand({
      selfHosted: true,
      orgSlug: "myOrg",
      projectSlug: "myProject",
      url: "https://santry.io",
      authToken: "_ignore",
      outDir: "someplace",
    });

    expect(command).toBe(
      "_SENTRY_RELEASE=$(sentry release propose-version | head -n 1) && SENTRY_URL='https://santry.io' sentry release create \"$_SENTRY_RELEASE\" --org='myOrg' --project='myProject' && SENTRY_URL='https://santry.io' sentry sourcemap upload --org='myOrg' --project='myProject' --release=\"$_SENTRY_RELEASE\" --no-rewrite 'someplace'",
    );
  });
});

describe("safeInsertArgsToWranglerDeployCommand", () => {
  it("correctly inserts args into default command", () => {
    const newCommand = safeInsertArgsToWranglerDeployCommand(
      "wrangler deploy",
      "dist",
    );

    expect(newCommand).toBe(
      "wrangler deploy --outdir 'dist' --upload-source-maps --var SENTRY_RELEASE:$(sentry release propose-version | head -n 1)",
    );
  });

  it.each([
    "--outdir someplace",
    "--outdir=someplace",
    '--outdir="./someplace.js"',
  ])("retains existing %s arg", (arg) => {
    const newCommand = safeInsertArgsToWranglerDeployCommand(
      `wrangler deploy ${arg}`,
      "dist",
    );

    expect(newCommand).toBe(
      `wrangler deploy ${arg} --upload-source-maps --var SENTRY_RELEASE:$(sentry release propose-version | head -n 1)`,
    );
  });

  it.each([
    "--upload-source-maps",
    "--upload-source-maps=true",
    "--upload-source-maps true",
    "--upload-source-maps=false",
    "--upload-source-maps false",
  ])("retains existing %s arg", (arg) => {
    const newCommand = safeInsertArgsToWranglerDeployCommand(
      `wrangler deploy ${arg}`,
      "dist",
    );

    expect(newCommand).toBe(
      `wrangler deploy ${arg} --outdir 'dist' --var SENTRY_RELEASE:$(sentry release propose-version | head -n 1)`,
    );
  });

  it('appends to the "wrangler deploy" command', () => {
    const newCommand = safeInsertArgsToWranglerDeployCommand(
      "precheck && wrangler  deploy --outdir dist --upload-source-maps --var SOMEVAR:someValue && postcheck",
      "dist",
    );

    expect(newCommand).toBe(
      "precheck && wrangler  deploy --outdir dist --upload-source-maps --var SOMEVAR:someValue  --var SENTRY_RELEASE:$(sentry release propose-version | head -n 1) && postcheck",
    );
  });

  it("handles multiple wrangler commands", () => {
    const newCommand = safeInsertArgsToWranglerDeployCommand(
      "wrangler whoami && wrangler deploy --outdir dist --upload-source-maps --var SOMEVAR:someValue && wrangler someothercommand",
      "dist",
    );

    expect(newCommand).toBe(
      "wrangler whoami && wrangler deploy --outdir dist --upload-source-maps --var SOMEVAR:someValue  --var SENTRY_RELEASE:$(sentry release propose-version | head -n 1) && wrangler someothercommand",
    );
  });

  it("handles wrangler deploy command with global args", () => {
    const newCommand = safeInsertArgsToWranglerDeployCommand(
      "wrangler --version --env production deploy --outdir someplace",
      "dist",
    );

    expect(newCommand).toBe(
      "wrangler --version --env production deploy --outdir someplace --upload-source-maps --var SENTRY_RELEASE:$(sentry release propose-version | head -n 1)",
    );
  });

  it("handles multiple commands and wrangler deploy command with global args", () => {
    const newCommand = safeInsertArgsToWranglerDeployCommand(
      "notwrangler --version deploy && wrangler --version --env whoami && wrangler --version --env production deploy --outdir someplace",
      "dist",
    );

    expect(newCommand).toBe(
      "notwrangler --version deploy && wrangler --version --env whoami && wrangler --version --env production deploy --outdir someplace --upload-source-maps --var SENTRY_RELEASE:$(sentry release propose-version | head -n 1)",
    );
  });

  it.each([
    "notwrangler deploy",
    "wrangler dev",
    "wrangler dev && notwrangler deploy",
    "wrangler dev ; notwrangler deploy",
    "wrangler dev; notwrangler deploy",
    "wrangler dev ;notwrangler deploy",
    "wrangler --env dev dev && notwrangler deploy",
    "some completely different command",
  ])("returns undefined if deploy command is not found", (command) => {
    const newCommand = safeInsertArgsToWranglerDeployCommand(command, "dist");

    expect(newCommand).toBeUndefined();
  });
});

describe("findOutDir", () => {
  it("returns dist dir if no outdir arg is found", () => {
    const outDir = findOutDir("wrangler deploy");

    expect(outDir).toBe(DIST_DIR);
  });

  it("returns outdir arg if it is found", () => {
    const outDir = findOutDir("wrangler deploy --outdir someplace");

    expect(outDir).toBe("someplace");
  });

  it('handles --outdir "./someplace.js"', () => {
    const outDir = findOutDir('wrangler deploy --outdir "./someplace.js"');

    expect(outDir).toBe("./someplace.js");
  });

  it("handles --outdir=someplace", () => {
    const outDir = findOutDir("wrangler deploy --outdir=someplace");

    expect(outDir).toBe("someplace");
  });

  it("handles --outdir='./someplace.js'", () => {
    const outDir = findOutDir('wrangler deploy --outdir="./someplace.js"');

    expect(outDir).toBe("./someplace.js");
  });

  it("returns dist dir if deploy command is not found", () => {
    const outDir = findOutDir(
      "wrangler --environment testing dev --outdir someplace",
    );

    expect(outDir).toBe(DIST_DIR);
  });
});

describe("getWranglerDeployCommand", () => {
  it("returns the deploy command", () => {
    const deployCommand = getWranglerDeployCommand(
      "wrangler deploy --outdir someplace",
    );

    expect(deployCommand).toBe("wrangler deploy --outdir someplace");
  });

  it("keeps the release version pipe inside the deploy command", () => {
    const deployCommand = safeInsertArgsToWranglerDeployCommand(
      "wrangler deploy && postcheck",
      "dist",
    );

    const rerunDeployCommand = getWranglerDeployCommand(deployCommand ?? "");

    expect(rerunDeployCommand?.replace(/\s+/g, " ").trim()).toBe(
      "wrangler deploy --outdir 'dist' --upload-source-maps --var SENTRY_RELEASE:$(sentry release propose-version | head -n 1)",
    );
  });

  it("returns undefined if deploy command is not found", () => {
    const deployCommand = getWranglerDeployCommand(
      "wrangler --environment testing dev --outdir someplace",
    );

    expect(deployCommand).toBeUndefined();
  });

  it.each([
    "wrangler deploy --outdir someplace && some other command",
    "wrangler deploy --outdir someplace || some other command",
    "wrangler deploy --outdir someplace ; some other command",
    "wrangler deploy --outdir someplace && some other command || some other command",
    "yarn precheck && wrangler deploy --outdir someplace && some other command",
    "yarn precheck || wrangler deploy --outdir someplace && some other command",
    "npm run test; wrangler deploy --outdir someplace && some other command",
    "npm run test; wrangler version > text && wrangler deploy --outdir someplace && some other command",
    "wrangler deploy --outdir someplace > deployment.txt",
  ])("returns the deploy command for `%s`", (command) => {
    const deployCommand = getWranglerDeployCommand(command)?.trim();

    expect(deployCommand).toBe("wrangler deploy --outdir someplace");
  });
});

// Print the release and upload arguments instead of running the Sentry CLI.
// The `sentry` shell function shadows any `sentry` binary on PATH, so the
// script never reaches Sentry. `propose-version` prints a hint after the
// version, as `sentry` does when its output is piped. Command substitution
// payloads use printf so a quoting regression has no filesystem side effects.
function runSentryCliCommand(command: string): string[] {
  const script = `
sentry() {
  case "$1 $2" in
    'release propose-version') printf '%s\\n' 'release with spaces' 'Detected from git HEAD' ;;
    'release create' | 'sourcemap upload')
      if [ -n "$SENTRY_URL" ]; then
        printf '%s\\n' "SENTRY_URL=$SENTRY_URL"
      fi
      printf '%s\\n' "$@"
      ;;
  esac
}
unset SENTRY_URL
${command}`;
  return execFileSync("/bin/bash", ["-c", script], { encoding: "utf8" })
    .trimEnd()
    .split("\n");
}
