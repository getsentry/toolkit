/**
 * Exercises the shell installer with a fake downloaded executable. Real PTYs
 * verify terminal reconnection for setup and the existing init handoff.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  registryTemplate,
  type ServedAsset,
  toolkitDownload,
} from "./install-scenarios.js";

const installScript = join(import.meta.dirname, "..", "..", "install");
const downloadedExecutable = `#!/usr/bin/env bash
set -euo pipefail
record_tty() {
  for fd in 0 1 2; do
    if [[ -t "$fd" ]]; then
      printf '%s:true\\n' "$fd" >&3
    else
      printf '%s:false\\n' "$fd" >&3
    fi
  done
  if { : </dev/tty; } 2>/dev/null; then
    printf 'controlling:true\\n' >&3
  else
    printf 'controlling:false\\n' >&3
  fi
}
if [[ "$1" == "cli" && "$2" == "setup" ]]; then
  printf '%s\\n' "$@" > "$SENTRY_TEST_DIR/setup-args"
  printf '%s\\n' "$0" > "$SENTRY_TEST_DIR/setup-binary"
  record_tty 3> "$SENTRY_TEST_DIR/setup-tty"
  setup_dir="\${SENTRY_TEST_SETUP_INSTALL_DIR:-$SENTRY_INSTALL_DIR}"
  mkdir -p "$setup_dir"
  cp "$0" "$setup_dir/sentry"
  if [[ "\${SENTRY_TEST_KEEP_TEMP_BINARY:-}" != "1" ]]; then
    rm "$0"
  fi
  exit "\${SENTRY_TEST_SETUP_EXIT:-0}"
fi
printf '%s\\n' "$@" >> "$SENTRY_TEST_DIR/post-args"
printf '%s\\n' "$0" >> "$SENTRY_TEST_DIR/post-binary"
record_tty 3> "$SENTRY_TEST_DIR/post-tty"
exit "\${SENTRY_TEST_POST_EXIT:-0}"
`;

const hostAsset = `sentry-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const served: ServedAsset = {
  name: hostAsset,
  gz: gzipSync(downloadedExecutable),
  raw: downloadedExecutable,
};

describe("install script", () => {
  let testDir: string;
  let binDir: string;
  let installDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "sentry-install-test-"));
    binDir = join(testDir, "bin");
    installDir = join(testDir, "installed bin");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(testDir, "home"));
    env = {
      PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: join(testDir, "home"),
      SENTRY_INSTALL_DIR: installDir,
      SENTRY_CLI_NO_TELEMETRY: "1",
      SENTRY_TEST_DIR: testDir,
      SENTRY_TEST_INSTALL_SCRIPT: installScript,
      TMPDIR: testDir,
    };
    applyScenario(
      { ...INSTALL_SCENARIOS[0], name: "default" },
      served,
      testDir,
      env,
    );

    writeFileSync(
      join(binDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
out=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  if [[ "\${args[i]}" == "-o" ]]; then out="\${args[i + 1]}"; fi
done
emit() { if [[ -n "$out" ]]; then cat > "$out"; else cat; fi; }
printf '%s\\n' "$url" >> "$SENTRY_TEST_DIR/curl-urls"
case "$url" in
  https://release-registry.services.sentry.io/apps/sentry/*)
    version="\${url##*/}"
    if [[ "$version" == "latest" ]]; then version="$SENTRY_TEST_LATEST_VERSION"; fi
    if [[ "$SENTRY_TEST_REGISTRY_STATUS" == "200" ]]; then
      sed "s/__VERSION__/$version/g" "$SENTRY_TEST_REGISTRY_BODY" | emit
    else
      : | emit
    fi
    printf '%s' "$SENTRY_TEST_REGISTRY_STATUS"
    ;;
  *"/repos/getsentry/toolkit/releases?per_page=100&page="*)
    page_file="SENTRY_TEST_RELEASES_PAGE_\${url##*=}"
    if [[ -n "\${!page_file:-}" ]]; then cat "\${!page_file}"; else printf '[]'; fi
    ;;
  https://github.com/*/releases/download/*.gz)
    if [[ "\${SENTRY_TEST_GZ_MISSING:-}" == "1" ]]; then exit 22; fi
    emit < "$SENTRY_TEST_GZ_FILE"
    ;;
  https://github.com/*/releases/download/*)
    emit < "$SENTRY_TEST_RAW_FILE"
    ;;
  *)
    exit 91
    ;;
esac
`,
    );
    chmodSync(join(binDir, "curl"), 0o755);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test.each(INSTALL_SCENARIOS)("$name", (scenario) => {
    applyScenario(scenario, served, testDir, env);
    const result = spawnSync("bash", [installScript, "--no-modify-path"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });

    const output = result.stdout + result.stderr;
    if (scenario.ok) {
      expect(result.status, output).toBe(0);
      expect(existsSync(join(installDir, "sentry"))).toBe(true);
    } else {
      expect(result.status, output).not.toBe(0);
      expect(output).not.toContain("Unexpected failure at line");
      expect(recorded("setup-args")).toEqual([]);
    }
    for (const expected of scenario.output ?? []) {
      expect(output).toContain(expected);
    }
    expect(recorded("curl-urls")).toEqual(scenario.requests(hostAsset));
    expect(installerTempFiles()).toEqual([]);
  });

  test.each([
    {
      name: "compact",
      format: (json: string) => JSON.stringify(JSON.parse(json)),
    },
    { name: "pretty-printed", format: (json: string) => json },
    {
      name: "large",
      format: (json: string) =>
        JSON.stringify(
          { description: "x".repeat(96 * 1024), ...JSON.parse(json) },
          null,
          2,
        ),
    },
  ])("parses $name registry metadata", ({ format }) => {
    writeFileSync(
      env.SENTRY_TEST_REGISTRY_BODY as string,
      format(registryTemplate(served, {})),
    );
    const result = spawnSync("bash", [installScript, "--no-modify-path"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("curl-urls").at(-1)).toBe(
      toolkitDownload(LATEST_VERSION, `${hostAsset}.gz`),
    );
  });

  function recorded(name: string): string[] {
    const path = join(testDir, name);
    return existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n")
      : [];
  }

  function installerTempFiles(): string[] {
    return readdirSync(testDir).filter((name) =>
      name.startsWith("sentry-install-"),
    );
  }

  function configureNightlyDownload(redirect: boolean): void {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const architecture = process.arch === "arm64" ? "arm64" : "x64";
    const assetName = `sentry-${platform}-${architecture}.gz`;
    const gzipPath = join(testDir, assetName);
    const manifest = JSON.stringify({
      version: "nightly-test",
      layers: [
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar",
          digest: "sha256:test",
          annotations: { "org.opencontainers.image.title": assetName },
        },
      ],
    });

    writeFileSync(gzipPath, gzipSync(downloadedExecutable));
    env.SENTRY_TEST_GZIP = gzipPath;
    env.SENTRY_TEST_NIGHTLY_REDIRECT = redirect ? "1" : "0";
    writeFileSync(
      join(binDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
printf '%s\\n' "$url" >> "$SENTRY_TEST_DIR/curl-urls"
case "$url" in
  *"/token?"*)
    if [[ "\${SENTRY_TEST_NIGHTLY_TOKEN_FAIL:-0}" != "0" ]]; then
      exit 22
    fi
    printf '{"token":"test-token"}'
    ;;
  *"/manifests/nightly")
    if [[ "\${SENTRY_TEST_NIGHTLY_MANIFEST_FAIL:-0}" != "0" ]]; then
      exit 22
    fi
    cat <<'JSON'
${manifest}
JSON
    ;;
  "https://objects.example/nightly.gz")
    for arg in "$@"; do
      if [[ "$arg" == Authorization:* ]]; then
        exit 90
      fi
    done
    cat "$SENTRY_TEST_GZIP"
    ;;
  *"/blobs/"*)
    headers=""
    output=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -D) headers="$2"; shift 2 ;;
        -o) output="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [[ "$SENTRY_TEST_NIGHTLY_REDIRECT" == "1" ]]; then
      printf 'HTTP/1.1 307 Temporary Redirect\\r\\nLocation: https://objects.example/nightly.gz\\r\\n\\r\\n' > "$headers"
      : > "$output"
      printf '307'
    else
      printf 'HTTP/1.1 200 OK\\r\\n\\r\\n' > "$headers"
      cp "$SENTRY_TEST_GZIP" "$output"
      printf '200'
    fi
    ;;
  *)
    exit 91
    ;;
esac
`,
    );
    chmodSync(join(binDir, "curl"), 0o755);
    writeFileSync(
      join(binDir, "gunzip"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ $# -gt 0 && "$1" != "-c" ]]; then
  exit 64
fi
exec /usr/bin/gunzip "$@"
`,
    );
    chmodSync(join(binDir, "gunzip"), 0o755);
  }

  /** Run curl-style piped installation in a real controlling terminal. */
  function runInTerminal(
    options: { redirect?: string; detached?: boolean } = {},
  ) {
    const launcher = join(testDir, "piped-install.cjs");
    const command =
      'cat "$SENTRY_TEST_INSTALL_SCRIPT" | bash -s -- --version 0.31.0' +
      (options.redirect ?? "");
    writeFileSync(
      launcher,
      `const { spawnSync } = require("node:child_process");
const result = spawnSync("bash", ["-c", ${JSON.stringify(command)}], {
  stdio: "inherit", detached: ${options.detached ?? false}
});
process.exitCode = result.status ?? 1;
`,
    );
    // script(1) has different argument syntax on BSD and util-linux. A
    // detached shell retains its PTY output but cannot open /dev/tty.
    const args =
      process.platform === "darwin"
        ? ["-q", "/dev/null", process.execPath, launcher]
        : [
            "-q",
            "-e",
            "-c",
            '"$SENTRY_TEST_NODE" "$SENTRY_TEST_LAUNCHER"',
            "/dev/null",
          ];
    return spawnSync("script", args, {
      env: {
        ...env,
        SENTRY_TEST_NODE: process.execPath,
        SENTRY_TEST_LAUNCHER: launcher,
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  test("passes setup flags through and skips login without a terminal", () => {
    const result = spawnSync(
      "bash",
      [
        installScript,
        "--version",
        "0.31.0",
        "--no-modify-path",
        "--no-completions",
        "--no-agent-skills",
      ],
      { env, encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("setup-args")).toEqual([
      "cli",
      "setup",
      "--install",
      "--method",
      "curl",
      "--channel",
      "stable",
      "--no-modify-path",
      "--no-completions",
      "--no-agent-skills",
    ]);
    expect(recorded("setup-tty").slice(0, 3)).toEqual([
      "0:false",
      "1:false",
      "2:false",
    ]);
    expect(recorded("post-args")).toEqual([]);
    expect(existsSync(join(installDir, "sentry"))).toBe(true);
    expect(installerTempFiles()).toEqual([]);
    expect(recorded("curl-urls").at(-1)).toBe(
      toolkitDownload("0.31.0", `${hostAsset}.gz`),
    );
  });

  test.each([
    { response: "direct HTTP 200 response", redirect: false },
    { response: "HTTP redirect", redirect: true },
  ])("installs nightly from a $response", ({ redirect }) => {
    configureNightlyDownload(redirect);
    const result = spawnSync(
      "bash",
      [installScript, "--version", "nightly", "--no-modify-path"],
      { env, encoding: "utf8", timeout: 10_000 },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("setup-args")).toEqual([
      "cli",
      "setup",
      "--install",
      "--method",
      "curl",
      "--channel",
      "nightly",
      "--no-modify-path",
    ]);
    expect(existsSync(join(installDir, "sentry"))).toBe(true);
    expect(installerTempFiles()).toEqual([]);
    expect(recorded("curl-urls").slice(0, 3)).toEqual([
      "https://ghcr.io/token?scope=repository:getsentry/toolkit:pull",
      "https://ghcr.io/v2/getsentry/toolkit/manifests/nightly",
      "https://ghcr.io/v2/getsentry/toolkit/blobs/sha256:test",
    ]);
  });

  test.each([
    { failure: "token", flag: "SENTRY_TEST_NIGHTLY_TOKEN_FAIL" },
    { failure: "manifest", flag: "SENTRY_TEST_NIGHTLY_MANIFEST_FAIL" },
  ])(
    "does not fall back to legacy GHCR when Toolkit $failure fails",
    ({ flag }) => {
      configureNightlyDownload(false);
      env[flag] = "1";
      const result = spawnSync(
        "bash",
        [installScript, "--version", "nightly"],
        {
          env,
          encoding: "utf8",
          timeout: 10_000,
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        flag === "SENTRY_TEST_NIGHTLY_TOKEN_FAIL"
          ? "Failed to get GHCR token"
          : "Failed to fetch nightly manifest from GHCR",
      );
      expect(result.stderr).not.toContain("Unexpected failure at line");
      expect(recorded("curl-urls")).toEqual(
        flag === "SENTRY_TEST_NIGHTLY_TOKEN_FAIL"
          ? ["https://ghcr.io/token?scope=repository:getsentry/toolkit:pull"]
          : [
              "https://ghcr.io/token?scope=repository:getsentry/toolkit:pull",
              "https://ghcr.io/v2/getsentry/toolkit/manifests/nightly",
            ],
      );
      expect(recorded("setup-args")).toEqual([]);
      expect(existsSync(join(installDir, "sentry"))).toBe(false);
    },
  );

  test("checks further release pages before selecting a stable Toolkit CLI", () => {
    const firstPage = join(testDir, "releases-1.json");
    const secondPage = join(testDir, "releases-2.json");
    writeFileSync(
      firstPage,
      '[\n  {\n    "tag_name": "mcp@1.0.0",\n    "prerelease": false\n  }\n]\n',
    );
    writeFileSync(
      secondPage,
      '[\n  {\n    "tag_name": "cli@0.46.0",\n    "prerelease": false\n  }\n]\n',
    );
    env.SENTRY_TEST_RELEASES_PAGE_1 = firstPage;
    env.SENTRY_TEST_RELEASES_PAGE_2 = secondPage;
    env.SENTRY_TEST_REGISTRY_STATUS = "503";
    const result = spawnSync("bash", [installScript, "--no-modify-path"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("curl-urls").slice(0, 3)).toEqual([
      "https://release-registry.services.sentry.io/apps/sentry/latest",
      "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100&page=1",
      "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100&page=2",
    ]);
    expect(recorded("curl-urls")[3]).toBe(
      toolkitDownload("0.46.0", `${hostAsset}.gz`),
    );
  });

  test("skips SemVer prereleases even when GitHub marks them stable", () => {
    const firstPage = join(testDir, "releases-1.json");
    writeFileSync(
      firstPage,
      '[\n  {\n    "tag_name": "cli@0.47.0-dev.1",\n    "prerelease": false\n  },\n  {\n    "tag_name": "cli@0.46.0",\n    "prerelease": false\n  }\n]\n',
    );
    env.SENTRY_TEST_RELEASES_PAGE_1 = firstPage;
    env.SENTRY_TEST_REGISTRY_STATUS = "503";
    const result = spawnSync("bash", [installScript, "--no-modify-path"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("curl-urls")[2]).toBe(
      toolkitDownload("0.46.0", `${hostAsset}.gz`),
    );
    expect(recorded("setup-args")).toContain("stable");
  });

  test("selects the first stable CLI release from compact GitHub JSON", () => {
    const firstPage = join(testDir, "releases-1.json");
    writeFileSync(
      firstPage,
      JSON.stringify([
        {
          tag_name: "mcp@0.42.0",
          prerelease: false,
          body: 'A quoted "tag_name" in the release notes',
        },
        {
          prerelease: false,
          tag_name: "cli@0.47.0-dev.1",
        },
        {
          prerelease: false,
          assets: [{ tag_name: "cli@99.0.0", prerelease: false }],
          tag_name: "cli@0.46.0",
        },
      ]),
    );
    env.SENTRY_TEST_RELEASES_PAGE_1 = firstPage;
    env.SENTRY_TEST_REGISTRY_STATUS = "503";
    const result = spawnSync("bash", [installScript, "--no-modify-path"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("curl-urls")[2]).toBe(
      toolkitDownload("0.46.0", `${hostAsset}.gz`),
    );
  });

  test("reads a large releases page without SIGPIPE and selects its first stable CLI", () => {
    const firstPage = join(testDir, "releases-large.json");
    writeFileSync(
      firstPage,
      `[
  {
    "tag_name": "cli@0.46.0",
    "prerelease": false
  },
  {
    "tag_name": "cli@0.45.0",
    "prerelease": false,
    "body": "${"x".repeat(256 * 1024)}"
  }
]`,
    );
    env.SENTRY_TEST_RELEASES_PAGE_1 = firstPage;
    env.SENTRY_TEST_REGISTRY_STATUS = "503";
    const result = spawnSync("bash", [installScript, "--no-modify-path"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("curl-urls")).toContain(
      toolkitDownload("0.46.0", `${hostAsset}.gz`),
    );
    expect(existsSync(join(installDir, "sentry"))).toBe(true);
  });

  test("directs musl users to the npm package before downloading a glibc binary", () => {
    writeFileSync(
      join(binDir, "ldd"),
      "#!/bin/sh\nprintf 'musl libc (x86_64)\\n'\n",
      {
        mode: 0o700,
      },
    );
    const result = spawnSync("bash", [installScript, "--no-modify-path"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("npm install -g sentry");
    expect(recorded("curl-urls")).toEqual([]);
  });

  test("connects setup to the controlling terminal and cleans up after setup", () => {
    env.SENTRY_TEST_KEEP_TEMP_BINARY = "1";
    const result = runInTerminal();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("setup-tty")).toEqual([
      "0:true",
      "1:true",
      "2:true",
      "controlling:true",
    ]);
    expect(recorded("post-args")).toEqual([]);
    expect(existsSync(join(installDir, "sentry"))).toBe(true);
    expect(installerTempFiles()).toEqual([]);
  });

  test.each([
    {
      name: "stdout is redirected",
      redirect: " >/dev/null",
      expected: ["0:false", "1:false", "2:true", "controlling:true"],
    },
    {
      name: "stderr is redirected",
      redirect: " 2>/dev/null",
      expected: ["0:false", "1:true", "2:false", "controlling:true"],
    },
    {
      name: "terminal output has no controlling terminal",
      detached: true,
      expected: ["0:false", "1:true", "2:true", "controlling:false"],
    },
  ])("skips login when $name", ({ redirect, detached, expected }) => {
    const result = runInTerminal({ redirect, detached });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("setup-tty")).toEqual(expected);
    expect(recorded("post-args")).toEqual([]);
  });

  test("hands off to init instead of login when SENTRY_INIT is set", () => {
    env.SENTRY_INIT = "1";
    env.SENTRY_TEST_KEEP_TEMP_BINARY = "1";
    env.SENTRY_TEST_POST_EXIT = "7";
    const result = runInTerminal();
    expect(result.status, result.stdout + result.stderr).toBe(7);
    expect(recorded("setup-tty")[0]).toBe("0:false");
    expect(recorded("post-args")).toEqual(["init"]);
    expect(recorded("post-binary")).toEqual([join(installDir, "sentry")]);
    expect(recorded("post-tty")).toEqual([
      "0:true",
      "1:true",
      "2:true",
      "controlling:true",
    ]);
    expect(installerTempFiles()).toEqual([]);
  });

  test("initializes the new binary instead of a stale install outside PATH", () => {
    const home = env.HOME!;
    const staleDir = join(home, ".local", "bin");
    const currentDir = join(home, "bin");
    mkdirSync(staleDir, { recursive: true });
    mkdirSync(currentDir);
    writeFileSync(join(staleDir, "sentry"), downloadedExecutable);
    chmodSync(join(staleDir, "sentry"), 0o755);
    env.SENTRY_INSTALL_DIR = "";
    env.SENTRY_TEST_SETUP_INSTALL_DIR = currentDir;
    env.PATH = `${currentDir}:${env.PATH}`;
    env.SENTRY_INIT = "1";

    const result = runInTerminal();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(recorded("post-args")).toEqual(["init"]);
    expect(recorded("post-binary")).toEqual([join(currentDir, "sentry")]);
  });

  test.each([1, 130])(
    "preserves setup failure or interruption exit %i",
    (exitCode) => {
      env.SENTRY_TEST_SETUP_EXIT = String(exitCode);
      const result = runInTerminal();
      expect(result.status, result.stdout + result.stderr).toBe(exitCode);
      expect(recorded("post-args")).toEqual([]);
      expect(existsSync(join(installDir, "sentry"))).toBe(true);
    },
  );

  test.each([1, 130])("preserves non-interactive setup exit %i", (exitCode) => {
    env.SENTRY_TEST_SETUP_EXIT = String(exitCode);
    const result = spawnSync("bash", [installScript, "--version", "0.31.0"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(exitCode);
    expect(recorded("post-args")).toEqual([]);
    expect(existsSync(join(installDir, "sentry"))).toBe(true);
  });
});
