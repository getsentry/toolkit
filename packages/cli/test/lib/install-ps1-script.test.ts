/**
 * Exercises the PowerShell installer through `Invoke-Expression`, the same
 * path as `irm https://cli.sentry.dev/install.ps1 | iex`. Network cmdlets are
 * replaced with PowerShell functions (functions take precedence over cmdlets),
 * and the downloaded "binary" is a shell script, so the suite runs wherever
 * `pwsh` is available. It is skipped otherwise.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  applyScenario,
  INSTALL_SCENARIOS,
  LATEST_VERSION,
  type ServedAsset,
  toolkitDownload,
} from "./install-scenarios.js";

const installScript = join(import.meta.dirname, "..", "..", "install.ps1");
const hasPwsh =
  spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" })
    .status === 0;

const downloadedExecutable = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "cli" && "$2" == "setup" ]]; then
  printf '%s\\n' "$@" > "$SENTRY_TEST_DIR/setup-args"
  printf '%s\\n' "$SENTRY_INSTALL_DIR" > "$SENTRY_TEST_DIR/setup-install-dir"
  printf '%s\\n' "$PATH" > "$SENTRY_TEST_DIR/setup-path"
  mkdir -p "$SENTRY_INSTALL_DIR"
  cp "$0" "$SENTRY_INSTALL_DIR/sentry.exe"
  exit "\${SENTRY_TEST_SETUP_EXIT:-0}"
fi
printf '%s\\n' "$@" >> "$SENTRY_TEST_DIR/post-args"
printf '%s\\n' "$0" >> "$SENTRY_TEST_DIR/post-binary"
exit "\${SENTRY_TEST_POST_EXIT:-0}"
`;

// Mocks for the cmdlets the installer uses, followed by the iex invocation.
const harness = String.raw`
$ErrorActionPreference = 'Stop'
function Write-Record([string]$Name, [string]$Value) {
  Add-Content -LiteralPath (Join-Path $env:SENTRY_TEST_DIR $Name) -Value $Value
}
function New-HttpError([int]$Status) {
  $ex = [System.Exception]::new("HTTP $Status")
  Add-Member -InputObject $ex -NotePropertyName Response -NotePropertyValue ([pscustomobject]@{ StatusCode = $Status })
  return $ex
}
function Invoke-RestMethod {
  param([string]$Uri, [switch]$UseBasicParsing, [int]$TimeoutSec)
  Write-Record 'urls' $Uri
  if ($Uri -like 'https://release-registry.services.sentry.io/apps/sentry/*') {
    $status = [int]$env:SENTRY_TEST_REGISTRY_STATUS
    if ($status -ne 200) { throw (New-HttpError $status) }
    $version = $Uri.Split('/')[-1]
    if ($version -eq 'latest') { $version = $env:SENTRY_TEST_LATEST_VERSION }
    $body = (Get-Content -Raw -LiteralPath $env:SENTRY_TEST_REGISTRY_BODY).Replace('__VERSION__', $version)
    return ($body | ConvertFrom-Json)
  }
  if ($Uri -like 'https://api.github.com/repos/getsentry/toolkit/releases?per_page=100&page=*') {
    $page = $Uri.Split('=')[-1]
    $file = [Environment]::GetEnvironmentVariable("SENTRY_TEST_RELEASES_PAGE_$page")
    # Like Windows PowerShell 5.1, emit each JSON array as a single object.
    if ($file) { return ,(Get-Content -Raw -LiteralPath $file | ConvertFrom-Json -NoEnumerate) }
    return ,@()
  }
  throw "Unexpected Invoke-RestMethod $Uri"
}
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec,
    [string]$Method, $Headers, [string]$ContentType, $Body)
  Write-Record 'urls' $Uri
  if ($Uri -like 'https://github.com/*/releases/download/*.gz') {
    if ($env:SENTRY_TEST_GZ_MISSING -eq '1') { throw (New-HttpError 404) }
    Copy-Item -LiteralPath $env:SENTRY_TEST_GZ_FILE -Destination $OutFile
    # The installer decompresses into the existing path; pre-create it
    # executable so the fake binary can run on POSIX test hosts.
    $target = $OutFile.Substring(0, $OutFile.Length - 3)
    New-Item -ItemType File -Path $target -Force | Out-Null
    chmod +x $target
    return
  }
  if ($Uri -like 'https://github.com/*/releases/download/*') {
    Copy-Item -LiteralPath $env:SENTRY_TEST_RAW_FILE -Destination $OutFile
    chmod +x $OutFile
    return
  }
  throw "Unexpected Invoke-WebRequest $Uri"
}
Get-Content -Raw -LiteralPath $env:SENTRY_TEST_INSTALL_SCRIPT | Invoke-Expression
`;

const asset = "sentry-windows-x64.exe";
const served: ServedAsset = {
  name: asset,
  gz: gzipSync(downloadedExecutable),
  raw: downloadedExecutable,
};

describe.skipIf(!hasPwsh)("PowerShell install script", () => {
  let testDir: string;
  let installDir: string;
  let env: NodeJS.ProcessEnv;
  let harnessPath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "sentry-install-ps1-test-"));
    installDir = join(testDir, "installed bin");
    mkdirSync(join(testDir, "home"));
    harnessPath = join(testDir, "harness.ps1");
    writeFileSync(harnessPath, harness);

    env = {
      PATH: process.env.PATH,
      HOME: join(testDir, "home"),
      USERPROFILE: join(testDir, "home"),
      TMPDIR: testDir,
      OS: "Windows_NT",
      PROCESSOR_ARCHITECTURE: "AMD64",
      SENTRY_INSTALL_DIR: installDir,
      SENTRY_CLI_NO_TELEMETRY: "1",
      SENTRY_TEST_DIR: testDir,
      SENTRY_TEST_INSTALL_SCRIPT: installScript,
      GITHUB_PATH: join(testDir, "github-path"),
    };
    applyScenario(
      { ...INSTALL_SCENARIOS[0], name: "default" },
      served,
      testDir,
      env,
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function run() {
    return spawnSync(
      "pwsh",
      ["-NoProfile", "-NonInteractive", "-File", harnessPath],
      { env, encoding: "utf8", timeout: 60_000 },
    );
  }

  function recorded(name: string): string[] {
    const path = join(testDir, name);
    return existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n")
      : [];
  }

  test.each(INSTALL_SCENARIOS)("$name", (scenario) => {
    applyScenario(scenario, served, testDir, env);

    const result = run();

    const output = result.stdout + result.stderr;
    if (scenario.ok) {
      expect(result.status, output).toBe(0);
      expect(existsSync(join(installDir, "sentry.exe"))).toBe(true);
    } else {
      expect(result.status, output).not.toBe(0);
      expect(recorded("setup-args")).toEqual([]);
    }
    for (const expected of scenario.output ?? []) {
      expect(output).toContain(expected);
    }
    expect(recorded("urls")).toEqual(scenario.requests(asset));
    expect(
      readdirSync(testDir).filter((name) => name.startsWith("sentry-install-")),
    ).toEqual([]);
  });

  test("hands off to setup and puts the install dir on PATH", () => {
    const result = run();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("urls").at(-1)).toBe(
      toolkitDownload(LATEST_VERSION, `${asset}.gz`),
    );
    expect(recorded("setup-args")).toEqual([
      "cli",
      "setup",
      "--install",
      "--method",
      "curl",
      "--channel",
      "stable",
      "--no-modify-path",
    ]);
    expect(recorded("setup-install-dir")).toEqual([installDir]);
    expect(recorded("setup-path")[0]?.startsWith(`${installDir}:`)).toBe(true);
    expect(recorded("github-path")).toEqual([installDir]);
  });

  test("runs sentry init with the installed binary when SENTRY_INIT=1", () => {
    env.SENTRY_INIT = "1";

    const result = run();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("post-args")).toEqual(["init"]);
    expect(recorded("post-binary")).toEqual([join(installDir, "sentry.exe")]);
  });

  test("fails when sentry init fails", () => {
    env.SENTRY_INIT = "1";
    env.SENTRY_TEST_POST_EXIT = "7";

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "sentry init failed with exit code 7",
    );
    expect(recorded("post-args")).toEqual(["init"]);
  });

  test("leaves PATH alone when SENTRY_NO_MODIFY_PATH=1", () => {
    env.SENTRY_NO_MODIFY_PATH = "1";

    const result = run();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("github-path")).toEqual([]);
    expect(recorded("setup-path")[0]?.startsWith(`${installDir}:`)).toBe(false);
  });

  test.each([
    {
      name: "non-Windows hosts",
      setup: () => {
        delete env.OS;
      },
      message: "This installer is for Windows",
    },
    {
      name: "unsupported architectures",
      setup: () => {
        env.PROCESSOR_ARCHITECTURE = "ARM64";
      },
      message: "only windows-x64 is supported",
    },
    {
      name: "the nightly channel",
      setup: () => {
        env.SENTRY_VERSION = "nightly";
      },
      message: "sentry cli upgrade nightly",
    },
    {
      name: "a failed setup",
      setup: () => {
        env.SENTRY_TEST_SETUP_EXIT = "3";
      },
      message: "sentry cli setup failed with exit code 3",
    },
  ])("fails clearly for $name", ({ setup, message }) => {
    setup();

    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(message);
  });
});
