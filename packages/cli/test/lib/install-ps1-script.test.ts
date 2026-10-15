/**
 * Exercises the PowerShell installer through `Invoke-Expression`, the same
 * path as `irm https://cli.sentry.dev/install.ps1 | iex`. Network cmdlets are
 * replaced with PowerShell functions (functions take precedence over cmdlets),
 * and the downloaded "binary" is a shell script, so the suite runs wherever
 * `pwsh` is available. It is skipped otherwise.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
  if ($Uri -eq 'https://release-registry.services.sentry.io/apps/sentry/latest') {
    if ($env:SENTRY_TEST_REGISTRY_FAIL -eq '1') { throw (New-HttpError 503) }
    return ($env:SENTRY_TEST_REGISTRY_RESPONSE | ConvertFrom-Json)
  }
  if ($Uri -like 'https://api.github.com/repos/getsentry/toolkit/releases?per_page=100&page=*') {
    $page = $Uri.Split('=')[-1]
    $file = [Environment]::GetEnvironmentVariable("SENTRY_TEST_RELEASES_PAGE_$page")
    if ($file) { return (Get-Content -Raw -LiteralPath $file | ConvertFrom-Json) }
    return ,@()
  }
  if ($Uri -eq 'https://api.github.com/repos/getsentry/cli/releases/latest') {
    if ($env:SENTRY_TEST_GITHUB_FAIL -eq '1') { throw (New-HttpError 503) }
    return ($env:SENTRY_TEST_GITHUB_RESPONSE | ConvertFrom-Json)
  }
  throw "Unexpected Invoke-RestMethod $Uri"
}
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec,
    [string]$Method, $Headers, [string]$ContentType, $Body)
  Write-Record 'urls' $Uri
  if ($Uri -like 'https://api.github.com/repos/getsentry/toolkit/releases/tags/*') {
    $status = [int]$env:SENTRY_TEST_TOOLKIT_STATUS
    if ($status -ne 200) { throw (New-HttpError $status) }
    return [pscustomobject]@{ StatusCode = 200 }
  }
  if ($Uri -like 'https://api.github.com/repos/getsentry/cli/releases/tags/*') {
    $status = [int]$env:SENTRY_TEST_LEGACY_STATUS
    if ($status -ne 200) { throw (New-HttpError $status) }
    return [pscustomobject]@{ StatusCode = 200 }
  }
  if ($Uri -like 'https://github.com/*/releases/download/*') {
    Write-Record 'download-urls' $Uri
    if ($Uri.EndsWith('.gz')) {
      if ($env:SENTRY_TEST_GZ_MISSING -eq '1') { throw (New-HttpError 404) }
      Copy-Item -LiteralPath $env:SENTRY_TEST_FAKE_GZ -Destination $OutFile
      # The installer decompresses into the existing path; pre-create it
      # executable so the fake binary can run on POSIX test hosts.
      $target = $OutFile.Substring(0, $OutFile.Length - 3)
      New-Item -ItemType File -Path $target -Force | Out-Null
      chmod +x $target
      return
    }
    Copy-Item -LiteralPath $env:SENTRY_TEST_FAKE_BINARY -Destination $OutFile
    chmod +x $OutFile
    return
  }
  throw "Unexpected Invoke-WebRequest $Uri"
}
Get-Content -Raw -LiteralPath $env:SENTRY_TEST_INSTALL_SCRIPT | Invoke-Expression
`;

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

    const fakeBinary = join(testDir, "fake-binary");
    writeFileSync(fakeBinary, downloadedExecutable);
    chmodSync(fakeBinary, 0o755);
    const fakeGz = join(testDir, "fake-binary.gz");
    writeFileSync(fakeGz, gzipSync(downloadedExecutable));

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
      SENTRY_TEST_FAKE_BINARY: fakeBinary,
      SENTRY_TEST_FAKE_GZ: fakeGz,
      SENTRY_TEST_REGISTRY_RESPONSE: '{"version":"0.47.0"}',
      SENTRY_TEST_TOOLKIT_STATUS: "200",
      SENTRY_TEST_LEGACY_STATUS: "200",
      GITHUB_PATH: join(testDir, "github-path"),
    };
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

  test("installs the latest stable release from the release registry", () => {
    const result = run();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("download-urls")).toEqual([
      "https://github.com/getsentry/toolkit/releases/download/cli@0.47.0/sentry-windows-x64.exe.gz",
    ]);
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
    expect(existsSync(join(installDir, "sentry.exe"))).toBe(true);
    expect(
      readdirSync(testDir).filter((name) => name.startsWith("sentry-install-")),
    ).toEqual([]);
  });

  test("falls back to the newest stable Toolkit CLI release on GitHub", () => {
    env.SENTRY_TEST_REGISTRY_FAIL = "1";
    const page1 = join(testDir, "page-1.json");
    writeFileSync(
      page1,
      JSON.stringify([
        { tag_name: "mcp@1.2.3", prerelease: false },
        { tag_name: "cli@0.48.0", prerelease: true },
      ]),
    );
    const page2 = join(testDir, "page-2.json");
    writeFileSync(
      page2,
      JSON.stringify([{ tag_name: "cli@0.46.0", prerelease: false }]),
    );
    env.SENTRY_TEST_RELEASES_PAGE_1 = page1;
    env.SENTRY_TEST_RELEASES_PAGE_2 = page2;

    const result = run();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Trying GitHub");
    expect(recorded("download-urls")).toEqual([
      "https://github.com/getsentry/toolkit/releases/download/cli@0.46.0/sentry-windows-x64.exe.gz",
    ]);
  });

  test("installs a pinned version from the legacy repository", () => {
    env.SENTRY_VERSION = "v0.42.2";
    env.SENTRY_TEST_TOOLKIT_STATUS = "404";

    const result = run();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("urls")).not.toContain(
      "https://release-registry.services.sentry.io/apps/sentry/latest",
    );
    expect(recorded("download-urls")).toEqual([
      "https://github.com/getsentry/cli/releases/download/0.42.2/sentry-windows-x64.exe.gz",
    ]);
  });

  test("falls back to the uncompressed binary", () => {
    env.SENTRY_TEST_GZ_MISSING = "1";

    const result = run();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("download-urls")).toEqual([
      "https://github.com/getsentry/toolkit/releases/download/cli@0.47.0/sentry-windows-x64.exe.gz",
      "https://github.com/getsentry/toolkit/releases/download/cli@0.47.0/sentry-windows-x64.exe",
    ]);
    expect(existsSync(join(installDir, "sentry.exe"))).toBe(true);
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
