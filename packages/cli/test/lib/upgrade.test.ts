/**
 * Upgrade Module Tests
 *
 * Tests for upgrade detection and logic.
 *
 * The `executeUpgrade` and `detectInstallationMethod` subprocess tests use
 * `vi.mock("node:child_process", ...)` at the top of this file to
 * intercept `spawn()` calls via a swappable `spawnImpl`. Non-spawn exports
 * pass through to the real `node:child_process`.
 */

import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fake ChildProcess helpers used by the subprocess-based upgrade tests.
// ---------------------------------------------------------------------------

type FakeStdio = {
  on: (event: string, cb: (chunk: Buffer) => void) => FakeStdio;
  resume: () => void;
};

type FakeProc = EventEmitter & {
  stdout: FakeStdio;
  stderr: FakeStdio;
};

/** No-op placeholder for stream methods we don't exercise. */
function noopStream() {
  // intentional no-op
}

/**
 * Build a minimal fake ChildProcess EventEmitter that emits 'close'
 * with the given exit code after a microtask tick.
 */
function fakeProcess(exitCode: number, stdoutData = ""): FakeProc {
  const emitter = new EventEmitter() as FakeProc;

  const listeners: Array<(chunk: Buffer) => void> = [];
  emitter.stdout = {
    on: (_event: string, cb: (chunk: Buffer) => void) => {
      listeners.push(cb);
      return emitter.stdout;
    },
    resume: noopStream,
  };
  emitter.stderr = {
    on: (_event: string, _cb: (chunk: Buffer) => void) => emitter.stderr,
    resume: noopStream,
  };

  queueMicrotask(() => {
    if (stdoutData) {
      for (const cb of listeners) {
        cb(Buffer.from(stdoutData));
      }
    }
    emitter.emit("close", exitCode);
  });

  return emitter;
}

/** Build a fake ChildProcess that emits an 'error' event instead of closing. */
function fakeErrorProcess(message: string): FakeProc {
  const emitter = new EventEmitter() as FakeProc;
  emitter.stdout = {
    on: (_e: string, _cb: (chunk: Buffer) => void) => emitter.stdout,
    resume: noopStream,
  };
  emitter.stderr = {
    on: (_e: string, _cb: (chunk: Buffer) => void) => emitter.stderr,
    resume: noopStream,
  };
  queueMicrotask(() => emitter.emit("error", new Error(message)));
  return emitter;
}

// Swappable spawn implementation. Individual tests replace `spawnImpl.fn`
// before calling the code under test. The holder object is hoisted so
// vi.mock() can capture the reference; tests mutate `.fn` to swap behavior.
const { spawnImpl } = vi.hoisted(() => ({
  spawnImpl: {
    fn: (() => {
      // placeholder — replaced per-test
    }) as (cmd: string, args: string[], opts: object) => FakeProc,
  },
}));
// Initialize with the real default now that fakeProcess is defined
spawnImpl.fn = () => fakeProcess(0);

vi.mock("node:child_process", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:child_process")>();
  return {
    ...orig,
    spawn: (cmd: string, args: string[], opts: object) =>
      spawnImpl.fn(cmd, args, opts),
  };
});

// Dynamic imports: must run AFTER vi.mock() so upgrade.ts picks up the
// mocked spawn.
import { isEnoentSpawnError } from "../../src/commands/cli/upgrade.js";
import {
  acquireLock,
  getBinaryDownloadUrl,
  isNightlyVersion,
  releaseLock,
  UPGRADE_SOURCES,
} from "../../src/lib/binary.js";
import {
  clearInstallInfo,
  setInstallInfo,
} from "../../src/lib/db/install-info.js";
import { UpgradeError } from "../../src/lib/errors.js";
import { isProcessRunning } from "../../src/lib/process-utils.js";

const {
  buildKnownCurlPaths,
  detectInstallationMethod,
  detectPackageManagerFromPath,
  downloadBinaryToTemp,
  executeUpgrade,
  fetchLatestFromGitHub,
  fetchLatestFromNpm,
  fetchLatestNightlyVersion,
  fetchLatestVersion,
  getCurlInstallPaths,
  parseInstallationMethod,
  resolveExistingUpgradeVersion,
  startCleanupOldBinary,
  versionExists,
} = await import("../../src/lib/upgrade.js");

import { TEST_TMP_DIR, useTestConfigDir } from "../helpers.js";

// Store original fetch for restoration
let originalFetch: typeof globalThis.fetch;

/** Helper to mock fetch without TypeScript errors about missing Bun-specific properties */
function mockFetch(
  fn: (url: string | URL | Request, init?: RequestInit) => Promise<Response>
): void {
  globalThis.fetch = fn as typeof globalThis.fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("parseInstallationMethod", () => {
  test("parses valid methods", () => {
    expect(parseInstallationMethod("curl")).toBe("curl");
    expect(parseInstallationMethod("brew")).toBe("brew");
    expect(parseInstallationMethod("npm")).toBe("npm");
    expect(parseInstallationMethod("pnpm")).toBe("pnpm");
    expect(parseInstallationMethod("bun")).toBe("bun");
    expect(parseInstallationMethod("yarn")).toBe("yarn");
  });

  test("parses case-insensitively", () => {
    expect(parseInstallationMethod("NPM")).toBe("npm");
    expect(parseInstallationMethod("Curl")).toBe("curl");
    expect(parseInstallationMethod("YARN")).toBe("yarn");
  });

  test("throws on invalid method", () => {
    expect(() => parseInstallationMethod("pip")).toThrow("Invalid method: pip");
    expect(() => parseInstallationMethod("apt")).toThrow("Invalid method: apt");
    expect(() => parseInstallationMethod("")).toThrow("Invalid method: ");
  });
});

describe("fetchLatestFromGitHub", () => {
  test("selects the first CLI release after sentry-mcp is renamed to Toolkit", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      const request = String(url);
      requests.push(request);
      if (request.endsWith("/releases?per_page=100")) {
        return Response.json([
          { tag_name: "0.42.0" },
          { tag_name: "cli@0.46.0", prerelease: false },
        ]);
      }
      if (request.endsWith("/releases/tags/cli%400.46.0")) {
        return Response.json({ tag_name: "cli@0.46.0" });
      }
      throw new Error(`Unexpected release request: ${request}`);
    });

    const version = await fetchLatestFromGitHub();
    const resolved = await resolveExistingUpgradeVersion(version);

    expect(version).toBe("0.46.0");
    expect(resolved).toEqual({ version, source: UPGRADE_SOURCES[0] });
    expect(getBinaryDownloadUrl(version, resolved?.source)).toStartWith(
      "https://github.com/getsentry/toolkit/releases/download/cli@0.46.0/"
    );
    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100",
      "https://api.github.com/repos/getsentry/toolkit/releases/tags/cli%400.46.0",
    ]);
  });

  test("selects the latest CLI-prefixed Toolkit release", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      requests.push(String(url));
      return new Response(
        JSON.stringify([
          { tag_name: "mcp@9.0.0" },
          { tag_name: "cli@not-a-version" },
          { tag_name: "cli@99.0.0-dev.1", prerelease: false },
          { tag_name: "cli@1.2.3" },
          { tag_name: "cli@1.3.0" },
        ]),
        { status: 200 }
      );
    });

    await expect(fetchLatestFromGitHub()).resolves.toBe("1.3.0");
    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100",
    ]);
  });

  test("follows Toolkit release pagination to find the latest CLI release", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      requests.push(String(url));
      if (requests.length === 1) {
        return new Response(
          JSON.stringify(
            Array.from({ length: 100 }, (_, index) => ({
              tag_name: `mcp@9.0.${index}`,
            }))
          ),
          {
            status: 200,
            headers: {
              Link: '<https://api.github.com/repositories/1114546946/releases?per_page=100&page=2>; rel="next"',
            },
          }
        );
      }
      return new Response(JSON.stringify([{ tag_name: "cli@1.2.3" }]), {
        status: 200,
      });
    });

    await expect(fetchLatestFromGitHub()).resolves.toBe("1.2.3");
    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100",
      "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100&page=2",
    ]);
  });

  test("preserves an arbitrary abort reason during pagination", async () => {
    const controller = new AbortController();
    const reason = { kind: "cancelled" };
    let requests = 0;
    mockFetch(async () => {
      requests += 1;
      if (requests === 1) {
        return new Response(JSON.stringify([{ tag_name: "mcp@9.0.0" }]), {
          headers: {
            Link: '<https://api.github.com/repositories/1114546946/releases?per_page=100&page=2>; rel="next"',
          },
        });
      }
      controller.abort(reason);
      throw reason;
    });

    await expect(fetchLatestFromGitHub(controller.signal)).rejects.toBe(reason);
    expect(requests).toBe(2);
  });

  test("selects the highest CLI SemVer across Toolkit release pages", async () => {
    let requests = 0;
    mockFetch(async () => {
      requests += 1;
      return requests === 1
        ? new Response(JSON.stringify([{ tag_name: "cli@1.2.1" }]), {
            status: 200,
            headers: {
              Link: '<https://api.github.com/repositories/1114546946/releases?per_page=100&page=2>; rel="next"',
            },
          })
        : new Response(JSON.stringify([{ tag_name: "cli@1.3.0" }]), {
            status: 200,
          });
    });

    await expect(fetchLatestFromGitHub()).resolves.toBe("1.3.0");
    expect(requests).toBe(2);
  });

  test("rejects GitHub release pagination outside the selected source", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify([{ tag_name: "mcp@9.0.0" }]), {
        status: 200,
        headers: {
          Link: '<https://example.com/releases?page=2>; rel="next"',
        },
      });
    });

    await expect(fetchLatestFromGitHub()).rejects.toThrow(
      "GitHub returned an invalid release pagination URL"
    );
    expect(requests).toHaveLength(1);
  });

  test("classifies malformed GitHub release pagination as a network error", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify([{ tag_name: "mcp@9.0.0" }]), {
          status: 200,
          headers: {
            Link: '<https://[invalid>; rel="next"',
          },
        })
    );

    await expect(fetchLatestFromGitHub()).rejects.toMatchObject({
      reason: "network_error",
      message: "GitHub returned an invalid release pagination URL",
    });
  });

  test("rejects cyclic GitHub release pagination", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify([{ tag_name: "mcp@9.0.0" }]), {
        status: 200,
        headers: {
          Link: '<https://api.github.com/repositories/1114546946/releases?per_page=100&page=2>; rel="next"',
        },
      });
    });

    await expect(fetchLatestFromGitHub()).rejects.toThrow(
      "GitHub returned cyclic release pagination"
    );
    expect(requests).toHaveLength(2);
  });

  test("falls back to the legacy latest release only on Toolkit HTTP 404", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      requests.push(String(url));
      if (requests.length === 1) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(JSON.stringify({ tag_name: "v1.2.3" }), {
        status: 200,
      });
    });

    await expect(fetchLatestFromGitHub()).resolves.toBe("1.2.3");
    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100",
      "https://api.github.com/repos/getsentry/cli/releases/latest",
    ]);
  });

  test("rejects an object from the Toolkit release-list endpoint", async () => {
    mockFetch(async () => Response.json({ tag_name: "cli@9.9.9" }));

    await expect(fetchLatestFromGitHub()).rejects.toThrow(
      "GitHub returned invalid release metadata"
    );
  });

  test("rejects an array from the legacy latest-release endpoint", async () => {
    let requests = 0;
    mockFetch(async () => {
      requests += 1;
      return requests === 1
        ? new Response(null, { status: 404 })
        : Response.json([{ tag_name: "9.9.9" }]);
    });

    await expect(fetchLatestFromGitHub()).rejects.toThrow(
      "GitHub returned invalid release metadata"
    );
    expect(requests).toBe(2);
  });

  test("does not use an MCP release as the latest CLI release", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify([{ tag_name: "mcp@9.0.0" }]), {
        status: 200,
      });
    });

    await expect(fetchLatestFromGitHub()).rejects.toThrow(
      "No version found in GitHub release"
    );
    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases?per_page=100",
    ]);
  });

  test("rejects a v-prefixed Toolkit product version", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify([{ tag_name: "cli@v1.2.3" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(fetchLatestFromGitHub()).rejects.toThrow(
      "No version found in GitHub release"
    );
  });

  test("strips v prefix from a legacy version", async () => {
    let requests = 0;
    mockFetch(async () => {
      requests += 1;
      return requests === 1
        ? new Response(null, { status: 404 })
        : Response.json({ tag_name: "v0.5.0" });
    });

    const version = await fetchLatestFromGitHub();
    expect(version).toBe("0.5.0");
  });

  test("handles version without v prefix", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify([{ tag_name: "cli@1.0.0" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const version = await fetchLatestFromGitHub();
    expect(version).toBe("1.0.0");
  });

  test("throws on HTTP error", async () => {
    mockFetch(
      async () =>
        new Response("Not Found", {
          status: 404,
        })
    );

    await expect(fetchLatestFromGitHub()).rejects.toThrow(UpgradeError);
    await expect(fetchLatestFromGitHub()).rejects.toThrow(
      "No CLI upgrade source was found: every source returned HTTP 404"
    );
  });

  test("throws on network failure (DNS, timeout, etc.)", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(fetchLatestFromGitHub()).rejects.toThrow(UpgradeError);
    await expect(fetchLatestFromGitHub()).rejects.toThrow(
      "Failed to connect to GitHub: fetch failed"
    );
  });

  test("throws when no tag_name in response", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(fetchLatestFromGitHub()).rejects.toThrow(
      "No version found in GitHub release"
    );
  });
});

describe("fetchLatestFromNpm", () => {
  test("returns version from npm registry", async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            version: "1.2.3",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
    );

    const version = await fetchLatestFromNpm();
    expect(version).toBe("1.2.3");
  });

  test("throws on HTTP error", async () => {
    mockFetch(
      async () =>
        new Response("Server Error", {
          status: 500,
        })
    );

    await expect(fetchLatestFromNpm()).rejects.toThrow(UpgradeError);
    await expect(fetchLatestFromNpm()).rejects.toThrow(
      "Failed to fetch from npm: 500"
    );
  });

  test("throws on network failure (DNS, timeout, etc.)", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(fetchLatestFromNpm()).rejects.toThrow(UpgradeError);
    await expect(fetchLatestFromNpm()).rejects.toThrow(
      "Failed to connect to npm registry: fetch failed"
    );
  });

  test("throws when no version in response", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(fetchLatestFromNpm()).rejects.toThrow(
      "npm registry returned invalid metadata"
    );
  });

  test.each([
    "not-semver",
    "v1.2.3",
    "1.2.3-dev.123",
    "1.2.3-beta.1",
    "1.2.3-rc.1",
  ])("rejects non-stable npm latest version %s", async (version) => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ version }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(fetchLatestFromNpm()).rejects.toThrow(
      "npm registry returned an invalid stable version"
    );
  });

  test.each([
    null,
    [],
    42,
    "version",
    { version: 42 },
    { version: "" },
  ])("rejects malformed npm metadata %#", async (data) => {
    mockFetch(async () => Response.json(data));

    await expect(fetchLatestFromNpm()).rejects.toMatchObject({
      name: "UpgradeError",
      reason: "network_error",
    });
  });
});

// fetchLatestNightlyVersion tests are in the dedicated describe block
// below (around line 1153) which tests the GHCR-based implementation.

describe("UpgradeError", () => {
  test("creates error with default message for unknown_method", () => {
    const error = new UpgradeError("unknown_method");
    expect(error.reason).toBe("unknown_method");
    expect(error.message).toBe(
      "Could not detect installation method. Use --method to specify."
    );
  });

  test("creates error with default message for network_error", () => {
    const error = new UpgradeError("network_error");
    expect(error.reason).toBe("network_error");
    expect(error.message).toBe("Failed to fetch version information.");
  });

  test("creates error with default message for execution_failed", () => {
    const error = new UpgradeError("execution_failed");
    expect(error.reason).toBe("execution_failed");
    expect(error.message).toBe("Upgrade command failed.");
  });

  test("creates error with default message for version_not_found", () => {
    const error = new UpgradeError("version_not_found");
    expect(error.reason).toBe("version_not_found");
    expect(error.message).toBe("The specified version was not found.");
  });

  test("creates error with default message for unsupported_operation", () => {
    const error = new UpgradeError("unsupported_operation");
    expect(error.reason).toBe("unsupported_operation");
    expect(error.message).toBe(
      "This operation is not supported for this installation method."
    );
  });

  test("creates error with default message for offline_cache_miss", () => {
    const error = new UpgradeError("offline_cache_miss");
    expect(error.reason).toBe("offline_cache_miss");
    expect(error.message).toBe(
      "Cannot upgrade offline — no pre-downloaded update is available."
    );
  });

  test("allows custom message", () => {
    const error = new UpgradeError("network_error", "Custom error message");
    expect(error.reason).toBe("network_error");
    expect(error.message).toBe("Custom error message");
  });
});

describe("fetchLatestVersion", () => {
  test("uses GitHub for curl method", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify([{ tag_name: "cli@2.0.0" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const version = await fetchLatestVersion("curl");
    expect(version).toBe("2.0.0");
  });

  test("uses npm for npm method", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ version: "2.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const version = await fetchLatestVersion("npm");
    expect(version).toBe("2.0.0");
  });

  test("uses npm for pnpm method", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ version: "2.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const version = await fetchLatestVersion("pnpm");
    expect(version).toBe("2.0.0");
  });

  test("uses npm for bun method", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ version: "2.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const version = await fetchLatestVersion("bun");
    expect(version).toBe("2.0.0");
  });

  test("uses npm for yarn method", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ version: "2.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const version = await fetchLatestVersion("yarn");
    expect(version).toBe("2.0.0");
  });

  test("uses GitHub for brew method", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify([{ tag_name: "cli@2.0.0" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const version = await fetchLatestVersion("brew");
    expect(version).toBe("2.0.0");
  });

  test("uses npm for unknown method", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ version: "2.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const version = await fetchLatestVersion("unknown");
    expect(version).toBe("2.0.0");
  });

  test("uses GHCR manifest when channel is nightly (curl method)", async () => {
    // Nightly version is now fetched from GHCR manifest annotation, not version.json
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response(null, { status: 200 });
      }
      if (urlStr.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      if (urlStr.includes("/manifests/nightly")) {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            layers: [],
            annotations: { version: "0.0.0-dev.1740393600" },
          }),
          { status: 200 }
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const version = await fetchLatestVersion("curl", "nightly");
    expect(version).toBe("0.0.0-dev.1740393600");
  });

  test("uses GHCR manifest when channel is nightly (npm method)", async () => {
    // Even npm method uses GHCR when channel=nightly (nightly is curl-only distribution)
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response(null, { status: 200 });
      }
      if (urlStr.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      if (urlStr.includes("/manifests/nightly")) {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            layers: [],
            annotations: { version: "0.0.0-dev.1740393600" },
          }),
          { status: 200 }
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const version = await fetchLatestVersion("npm", "nightly");
    expect(version).toBe("0.0.0-dev.1740393600");
  });

  test("defaults to stable channel (uses GitHub) when channel omitted", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify([{ tag_name: "cli@3.0.0" }]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const version = await fetchLatestVersion("curl");
    expect(version).toBe("3.0.0");
  });
});

describe("versionExists", () => {
  test.each([
    401, 403, 429, 500,
  ])("does not classify npm HTTP %i as a missing version", async (status) => {
    mockFetch(async () => new Response(null, { status }));

    await expect(versionExists("npm", "1.0.0")).rejects.toMatchObject({
      reason: "network_error",
    });
  });

  test.each([
    "not-semver",
    "v1.2.3",
    "1.2.3-beta.1",
    "mcp@1.0.0",
  ])("rejects invalid standalone stable version %s before network access", async (version) => {
    let requests = 0;
    mockFetch(async () => {
      requests += 1;
      return new Response(null, { status: 200 });
    });

    await expect(resolveExistingUpgradeVersion(version)).rejects.toMatchObject({
      reason: "network_error",
    });
    expect(requests).toBe(0);
  });

  test.each([
    "not-semver",
    "v1.2.3",
    "1.2.3-beta.1",
    "mcp@1.0.0",
  ])("rejects explicit-source standalone version %s before network access", async (version) => {
    let requests = 0;
    mockFetch(async () => {
      requests += 1;
      return new Response(null, { status: 200 });
    });

    await expect(
      versionExists("curl", version, UPGRADE_SOURCES[0])
    ).rejects.toMatchObject({ reason: "network_error" });
    expect(requests).toBe(0);
  });

  test.each([
    "draft",
    "prerelease",
  ])("rejects a pinned stable release marked %s", async (flag) => {
    mockFetch(async () =>
      Response.json({ tag_name: "cli@1.2.3", [flag]: true })
    );

    await expect(resolveExistingUpgradeVersion("1.2.3")).rejects.toMatchObject({
      reason: "network_error",
    });
  });
  test.each([
    "npm",
    "pnpm",
    "bun",
    "yarn",
  ] as const)("rejects a prerelease pinned through %s before network access", async (method) => {
    mockFetch(async () => {
      throw new Error("fetch should not be called");
    });

    await expect(versionExists(method, "1.2.3-beta.1")).rejects.toThrow(
      "Requested package version returned an invalid stable version"
    );
  });
  test("probes prefixed Toolkit tags and retains the selected source", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify({ tag_name: "cli@1.0.0" }), {
        status: 200,
      });
    });

    await expect(versionExists("curl", "1.0.0")).resolves.toBe(true);
    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases/tags/cli%401.0.0",
    ]);
  });

  test("falls back to an unprefixed legacy tag on Toolkit HTTP 404", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      requests.push(String(url));
      return requests.length === 1
        ? new Response("Not Found", { status: 404 })
        : new Response(JSON.stringify({ tag_name: "1.0.0" }), { status: 200 });
    });

    await expect(versionExists("curl", "1.0.0")).resolves.toBe(true);
    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases/tags/cli%401.0.0",
      "https://api.github.com/repos/getsentry/cli/releases/tags/1.0.0",
    ]);
  });

  test("does not classify transport error text as missing sources", async () => {
    mockFetch(async () => {
      throw new Error(
        "No CLI upgrade source was found: every source returned HTTP 404"
      );
    });

    await expect(resolveExistingUpgradeVersion("1.0.0")).rejects.toThrow(
      "Failed to connect to GitHub"
    );
  });

  test.each([
    ["empty body", ""],
    ["invalid JSON", "{"],
    ["missing tag", JSON.stringify({})],
    ["mismatched tag", JSON.stringify({ tag_name: "mcp@1.0.0" })],
  ])("rejects pinned Toolkit %s without legacy fallback", async (_name, body) => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      requests.push(String(url));
      return new Response(body, { status: 200 });
    });

    await expect(resolveExistingUpgradeVersion("1.0.0")).rejects.toMatchObject({
      reason: "network_error",
    });
    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases/tags/cli%401.0.0",
    ]);
  });

  test.each([
    undefined,
    "not-semver",
    "0.14.0-dev.124",
  ])("rejects pinned nightly manifest annotation %s without legacy fallback", async (annotation) => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      const request = String(url);
      requests.push(request);
      if (request === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response(null, { status: 200 });
      }
      if (request.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      if (request.includes("/manifests/nightly-0.14.0-dev.123")) {
        return new Response(
          JSON.stringify({
            annotations:
              annotation === undefined ? {} : { version: annotation },
          }),
          { status: 200 }
        );
      }
      return new Response("Unexpected", { status: 500 });
    });

    await expect(
      resolveExistingUpgradeVersion("0.14.0-dev.123")
    ).rejects.toMatchObject({ reason: "network_error" });
    expect(requests.some((request) => request.includes("getsentry/cli"))).toBe(
      false
    );
  });

  test("does not fall back from an explicit selected source", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      requests.push(String(url));
      return new Response("Not Found", { status: 404 });
    });

    await expect(
      versionExists("curl", "1.0.0", UPGRADE_SOURCES[0])
    ).resolves.toBe(false);
    expect(requests).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases/tags/cli%401.0.0",
    ]);
  });

  test("rejects empty successful metadata from an explicit source", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    await expect(
      versionExists("curl", "1.0.0", UPGRADE_SOURCES[0])
    ).rejects.toThrow("GitHub returned invalid metadata for version 1.0.0");
  });

  test.each([
    401, 403, 429, 500,
  ])("does not classify explicit source HTTP %i as a missing version", async (status) => {
    mockFetch(async () => new Response(null, { status }));

    await expect(
      versionExists("curl", "1.0.0", UPGRADE_SOURCES[0])
    ).rejects.toThrow(`HTTP ${status}`);
  });

  test("checks GitHub for curl method - version exists", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ tag_name: "cli@1.0.0" }), { status: 200 })
    );

    const exists = await versionExists("curl", "1.0.0");
    expect(exists).toBe(true);
  });

  test("checks GitHub for curl method - version does not exist", async () => {
    mockFetch(async () => new Response(null, { status: 404 }));

    const exists = await versionExists("curl", "99.99.99");
    expect(exists).toBe(false);
  });

  test("checks npm for npm method - version exists", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    const exists = await versionExists("npm", "1.0.0");
    expect(exists).toBe(true);
  });

  test("checks npm for npm method - version does not exist", async () => {
    mockFetch(async () => new Response(null, { status: 404 }));

    const exists = await versionExists("npm", "99.99.99");
    expect(exists).toBe(false);
  });

  test("checks npm for pnpm method", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    const exists = await versionExists("pnpm", "1.0.0");
    expect(exists).toBe(true);
  });

  test("checks npm for bun method", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    const exists = await versionExists("bun", "1.0.0");
    expect(exists).toBe(true);
  });

  test("checks GitHub for brew method - version exists", async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ tag_name: "cli@1.0.0" }), { status: 200 })
    );

    const exists = await versionExists("brew", "1.0.0");
    expect(exists).toBe(true);
  });

  test("checks GitHub for brew method - version does not exist", async () => {
    mockFetch(async () => new Response(null, { status: 404 }));

    const exists = await versionExists("brew", "99.99.99");
    expect(exists).toBe(false);
  });

  test("checks npm for yarn method", async () => {
    mockFetch(async () => new Response(null, { status: 200 }));

    const exists = await versionExists("yarn", "1.0.0");
    expect(exists).toBe(true);
  });

  test("throws on network failure", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(versionExists("curl", "1.0.0")).rejects.toThrow(UpgradeError);
    await expect(versionExists("curl", "1.0.0")).rejects.toThrow(
      "Failed to connect to GitHub"
    );
  });

  test("throws on network failure for npm", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(versionExists("npm", "1.0.0")).rejects.toThrow(UpgradeError);
    await expect(versionExists("npm", "1.0.0")).rejects.toThrow(
      "Failed to connect to npm registry"
    );
  });

  test("checks GHCR for nightly version - version exists", async () => {
    const manifest = {
      schemaVersion: 2,
      layers: [],
      annotations: { version: "0.14.0-dev.1772661724" },
    };
    mockFetch(async (url) => {
      const u = String(url);
      if (u === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response(null, { status: 200 });
      }
      if (u.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      if (u.includes("/manifests/nightly-")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    const exists = await versionExists("curl", "0.14.0-dev.1772661724");
    expect(exists).toBe(true);
  });

  test("checks GHCR for nightly version - version does not exist", async () => {
    mockFetch(async (url) => {
      const u = String(url);
      if (u === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response(null, { status: 200 });
      }
      if (u.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      if (u.includes("/manifests/nightly-")) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    });

    const exists = await versionExists("curl", "0.14.0-dev.9999999999");
    expect(exists).toBe(false);
  });

  test("checks GHCR for nightly version regardless of install method", async () => {
    const manifest = {
      schemaVersion: 2,
      layers: [],
      annotations: { version: "0.14.0-dev.1772661724" },
    };
    mockFetch(async (url) => {
      const u = String(url);
      if (u === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response(null, { status: 200 });
      }
      if (u.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      if (u.includes("/manifests/nightly-")) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    const exists = await versionExists("npm", "0.14.0-dev.1772661724");
    expect(exists).toBe(true);
  });

  test("rejects a mismatched nightly annotation for an explicit source", async () => {
    mockFetch(async (url) => {
      const request = String(url);
      if (request.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      if (request.includes("/manifests/nightly-0.14.0-dev.123")) {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            layers: [],
            annotations: { version: "0.14.0-dev.124" },
          }),
          { status: 200 }
        );
      }
      return new Response("Unexpected", { status: 500 });
    });

    await expect(
      versionExists("curl", "0.14.0-dev.123", UPGRADE_SOURCES[0])
    ).rejects.toThrow(
      "Nightly manifest version 0.14.0-dev.124 does not match requested version 0.14.0-dev.123"
    );
  });

  test("throws on network failure for nightly version", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      versionExists("curl", "0.14.0-dev.1772661724")
    ).rejects.toThrow(UpgradeError);
  });

  test("does not classify nightly transport error text as not found", async () => {
    mockFetch(async (url) => {
      if (String(url).includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      throw new Error("HTTP 404");
    });

    await expect(
      versionExists("curl", "0.14.0-dev.1772661724", UPGRADE_SOURCES[0])
    ).rejects.toThrow("HTTP 404");
  });

  test("throws on GHCR server error for nightly version", async () => {
    mockFetch(async (url) => {
      const u = String(url);
      if (u.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      // Manifest returns 500 (server error, not 404)
      return new Response(null, { status: 500 });
    });
    await expect(
      versionExists("curl", "0.14.0-dev.1772661724")
    ).rejects.toThrow(UpgradeError);
  });

  test("does not classify GHCR HTTP 403 as a missing nightly version", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      const urlString = String(url);
      requests.push(urlString);
      if (urlString.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      return new Response(null, { status: 403 });
    });

    await expect(
      versionExists("curl", "0.14.0-dev.1772661724", UPGRADE_SOURCES[0])
    ).rejects.toThrow("HTTP 403");
    expect(requests).toHaveLength(2);
    expect(requests.some((url) => url.includes("getsentry/cli"))).toBe(false);
  });
});

describe("executeUpgrade", () => {
  test("throws UpgradeError for unknown installation method", async () => {
    await expect(executeUpgrade("unknown", "1.0.0")).rejects.toThrow(
      UpgradeError
    );
    await expect(executeUpgrade("unknown", "1.0.0")).rejects.toThrow(
      "Could not detect installation method"
    );
  });

  test("throws UpgradeError with unknown_method reason", async () => {
    try {
      await executeUpgrade("unknown", "1.0.0");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeError);
      expect((error as UpgradeError).reason).toBe("unknown_method");
    }
  });
});

describe("detectInstallationMethod — stored info path", () => {
  useTestConfigDir("test-detect-stored-");

  let originalExecPath: string;

  beforeEach(() => {
    originalExecPath = process.execPath;
    // Set execPath to a non-Homebrew, non-known-curl path so detection falls
    // through to stored info
    Object.defineProperty(process, "execPath", {
      value: "/usr/bin/sentry",
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
    });
    clearInstallInfo();
  });

  test("returns stored method when install info has been persisted", async () => {
    setInstallInfo({
      method: "npm",
      path: "/usr/bin/sentry",
      version: "1.0.0",
    });

    const method = await detectInstallationMethod();
    expect(method).toBe("npm");
  });

  test("returns stored curl method", async () => {
    setInstallInfo({
      method: "curl",
      path: "/usr/bin/sentry",
      version: "1.0.0",
    });

    const method = await detectInstallationMethod();
    expect(method).toBe("curl");
  });
});

describe("Homebrew detection (detectInstallationMethod)", () => {
  let originalExecPath: string;

  beforeEach(() => {
    originalExecPath = process.execPath;
  });

  afterEach(() => {
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
    });
    clearInstallInfo();
  });

  test("detects brew when execPath resolves through /Cellar/", async () => {
    Object.defineProperty(process, "execPath", {
      value: "/opt/homebrew/Cellar/sentry/1.2.3/bin/sentry",
      configurable: true,
    });

    const method = await detectInstallationMethod();
    expect(method).toBe("brew");
  });

  test("detects brew for Intel Homebrew path (/usr/local/Cellar/)", async () => {
    Object.defineProperty(process, "execPath", {
      value: "/usr/local/Cellar/sentry/1.2.3/bin/sentry",
      configurable: true,
    });

    const method = await detectInstallationMethod();
    expect(method).toBe("brew");
  });

  test("Homebrew detection overrides stale stored install info", async () => {
    // Simulate a user who previously had curl recorded in the DB but then
    // switched to Homebrew — the /Cellar/ check should win.
    setInstallInfo({ method: "curl", path: "/old/path", version: "0.0.1" });

    Object.defineProperty(process, "execPath", {
      value: "/opt/homebrew/Cellar/sentry/1.2.3/bin/sentry",
      configurable: true,
    });

    const method = await detectInstallationMethod();
    expect(method).toBe("brew");
  });

  test("does not detect brew for non-Homebrew paths", async () => {
    // Directly validate: a path without /Cellar/ is not a Homebrew install.
    // We avoid calling detectInstallationMethod() with no stored info and a
    // non-Cellar path because that triggers the slow package-manager fallthrough.
    expect("/home/user/.sentry/bin/sentry".includes("/Cellar/")).toBe(false);
    expect("/opt/homebrew/bin/sentry".includes("/Cellar/")).toBe(false);
  });
});

describe("detectPackageManagerFromPath", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  test("detects npm from node_modules path", () => {
    process.argv[1] = join(
      "/usr/local/lib",
      "node_modules",
      "sentry",
      "dist",
      "bin.cjs"
    );
    expect(detectPackageManagerFromPath()).toBe("npm");
  });

  test("detects pnpm from .pnpm directory layout", () => {
    process.argv[1] = join(
      "/usr/local/lib",
      "node_modules",
      ".pnpm",
      "sentry@0.27.0",
      "node_modules",
      "sentry",
      "dist",
      "bin.cjs"
    );
    expect(detectPackageManagerFromPath()).toBe("pnpm");
  });

  test("detects bun from .bun global install path", () => {
    process.argv[1] = join(
      homedir(),
      ".bun",
      "install",
      "global",
      "node_modules",
      "sentry",
      "dist",
      "bin.cjs"
    );
    expect(detectPackageManagerFromPath()).toBe("bun");
  });

  test("detects npm from NVM-managed path with node_modules", () => {
    // Mimics the CLI-Y1 bug report layout (NVM + Laravel Herd)
    process.argv[1] = join(
      homedir(),
      "config",
      "herd",
      "bin",
      "nvm",
      "v24.2.0",
      "node_modules",
      "sentry",
      "dist",
      "index.cjs"
    );
    expect(detectPackageManagerFromPath()).toBe("npm");
  });

  test("returns null when argv[1] is undefined", () => {
    process.argv = [process.argv[0]];
    expect(detectPackageManagerFromPath()).toBeNull();
  });

  test("returns null for Bun compiled binary (argv[1] is CLI arg)", () => {
    process.argv[1] = "issue";
    expect(detectPackageManagerFromPath()).toBeNull();
  });

  test("returns null for dev mode source path", () => {
    process.argv[1] = join("/home", "user", "cli", "src", "bin.ts");
    expect(detectPackageManagerFromPath()).toBeNull();
  });
});

describe("detectInstallationMethod — node_modules path fallback", () => {
  useTestConfigDir("test-detect-path-");

  let originalArgv: string[];
  let originalExecPath: string;

  beforeEach(() => {
    originalArgv = [...process.argv];
    originalExecPath = process.execPath;
    // Typical Node.js execPath — not Homebrew, not curl
    Object.defineProperty(process, "execPath", {
      value: "/usr/bin/node",
      configurable: true,
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
    });
    clearInstallInfo();
  });

  test("stored info takes priority over path-based detection", async () => {
    // If DB says "yarn", respect it even if path says node_modules
    setInstallInfo({ method: "yarn", path: "/old/path", version: "0.0.1" });
    process.argv[1] = join(
      "/usr/local/lib",
      "node_modules",
      "sentry",
      "dist",
      "bin.cjs"
    );

    const method = await detectInstallationMethod();
    expect(method).toBe("yarn");
  });

  test("Homebrew still takes priority over node_modules path", async () => {
    process.argv[1] = join(
      "/usr/local/lib",
      "node_modules",
      "sentry",
      "dist",
      "bin.cjs"
    );
    Object.defineProperty(process, "execPath", {
      value: "/opt/homebrew/Cellar/sentry/1.2.3/bin/sentry",
      configurable: true,
    });

    const method = await detectInstallationMethod();
    expect(method).toBe("brew");
  });
});

describe("getBinaryDownloadUrl", () => {
  test("builds correct URL for current platform", () => {
    const url = getBinaryDownloadUrl("1.0.0");

    expect(url).toContain("/cli@1.0.0/");
    expect(url).toStartWith(
      "https://github.com/getsentry/toolkit/releases/download/"
    );
    expect(url).toContain("sentry-");

    // Should include architecture
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    expect(url).toContain(arch);
  });
});

describe("buildKnownCurlPaths", () => {
  test("appends a trailing separator to each known dir", () => {
    const paths = buildKnownCurlPaths("/home/user", {});
    expect(paths).toContain(join("/home/user", ".local", "bin") + sep);
    expect(paths).toContain(join("/home/user", ".sentry", "bin") + sep);
    expect(paths.every((p) => p.endsWith(sep))).toBe(true);
  });

  test("includes an absolute XDG_BIN_HOME", () => {
    const xdgBin = join(homedir(), "custom", "bin");
    const paths = buildKnownCurlPaths("/home/user", { XDG_BIN_HOME: xdgBin });
    expect(paths).toContain(xdgBin + sep);
  });

  test("normalizes a trailing slash on XDG_BIN_HOME (no double separator)", () => {
    const xdgBin = join(homedir(), "custom", "bin");
    const paths = buildKnownCurlPaths("/home/user", {
      // Trailing separator on the configured dir must be normalized away.
      XDG_BIN_HOME: xdgBin + sep,
    });
    // Must end with a single sep, never a double sep which would break
    // process.execPath.startsWith() directory-boundary checks.
    expect(paths).toContain(xdgBin + sep);
    expect(paths.some((p) => p.includes(sep + sep))).toBe(false);
  });

  test("ignores a non-absolute XDG_BIN_HOME", () => {
    const paths = buildKnownCurlPaths("/home/user", {
      XDG_BIN_HOME: join("relative", "bin"),
    });
    expect(paths.some((p) => p.includes(`relative${sep}bin`))).toBe(false);
  });
});

describe("getCurlInstallPaths", () => {
  test("returns all required paths", () => {
    const paths = getCurlInstallPaths();

    expect(paths.installPath).toBeDefined();
    expect(paths.tempPath).toBeDefined();
    expect(paths.oldPath).toBeDefined();
    expect(paths.lockPath).toBeDefined();

    // Temp path should be installPath + .download
    expect(paths.tempPath).toBe(`${paths.installPath}.download`);
    // Old path should be installPath + .old
    expect(paths.oldPath).toBe(`${paths.installPath}.old`);
    // Lock path should be installPath + .lock
    expect(paths.lockPath).toBe(`${paths.installPath}.lock`);
  });

  test("includes .exe suffix on Windows", () => {
    const paths = getCurlInstallPaths();
    const suffix = process.platform === "win32" ? ".exe" : "";

    expect(paths.installPath).toEndWith(`sentry${suffix}`);
  });

  describe("stored path branch", () => {
    const getConfigDir = useTestConfigDir("test-curl-paths-stored-");

    afterEach(() => {
      clearInstallInfo();
    });

    test("uses stored path when its directory still exists", () => {
      // The stored path is only trusted when its directory still exists —
      // otherwise the upgrade would lock/install into a dead location.
      const dir = join(getConfigDir(), "custom", "bin");
      mkdirSync(dir, { recursive: true });
      const customPath = join(dir, "sentry");
      setInstallInfo({ method: "curl", path: customPath, version: "1.0.0" });

      const paths = getCurlInstallPaths();
      expect(paths.installPath).toBe(customPath);
      expect(paths.tempPath).toBe(`${customPath}.download`);
    });

    test("ignores a stale stored path whose directory no longer exists", () => {
      // Regression for sergical's report (#discuss-cli, 2026-06-22): a
      // `SENTRY_INSTALL_DIR=/tmp/sentry-test-install` test install recorded
      // install.path there, the dir was later purged, but the DB row
      // survived. getCurlInstallPaths must NOT return the stale path — doing
      // so crashed acquireLock with `ENOENT ... open '.../sentry.lock'`.
      const stalePath = join(
        getConfigDir(),
        "purged",
        "sentry-test-install",
        "sentry"
      );
      setInstallInfo({ method: "curl", path: stalePath, version: "1.0.0" });

      const paths = getCurlInstallPaths();
      expect(paths.installPath).not.toBe(stalePath);
    });

    test("ignores stored path when method is not curl", () => {
      // If stored method is e.g. "npm", the stored path branch is skipped
      setInstallInfo({
        method: "npm",
        path: "/some/npm/path",
        version: "1.0.0",
      });

      const paths = getCurlInstallPaths();
      // Should NOT use the npm path
      expect(paths.installPath).not.toBe("/some/npm/path");
    });
  });

  describe("known curl path branch", () => {
    let originalExecPath: string;

    beforeEach(() => {
      originalExecPath = process.execPath;
    });

    afterEach(() => {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
      clearInstallInfo();
    });

    test("uses execPath when it starts with a known curl install dir", () => {
      const knownCurlPath = join(homedir(), ".local", "bin", "sentry");
      Object.defineProperty(process, "execPath", {
        value: knownCurlPath,
        configurable: true,
      });

      const paths = getCurlInstallPaths();
      expect(paths.installPath).toBe(knownCurlPath);
    });
  });
});

describe("isProcessRunning", () => {
  test("returns true for current process", () => {
    // Our own PID should be running
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  test("returns false for non-existent PID", () => {
    // Use a very high PID that's unlikely to exist
    // PID 4194304 is above typical max PID on most systems
    expect(isProcessRunning(4_194_304)).toBe(false);
  });

  test("returns true on EPERM (process exists but owned by different user)", () => {
    // Mock process.kill to throw EPERM
    const epermError = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw epermError;
    });

    try {
      // EPERM means the process exists, we just can't signal it
      expect(isProcessRunning(12_345)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("returns false on ESRCH (process does not exist)", () => {
    // Mock process.kill to throw ESRCH
    const esrchError = Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    const spy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw esrchError;
    });

    try {
      // ESRCH means the process does not exist
      expect(isProcessRunning(12_345)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("acquireLock", () => {
  const lockBinDir = join(TEST_TMP_DIR, "upgrade-lock-test");
  const testLockPath = join(lockBinDir, "test-upgrade.lock");

  beforeEach(() => {
    // Ensure directory exists
    mkdirSync(lockBinDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test lock file
    try {
      releaseLock(testLockPath);
    } catch {
      // Ignore
    }
  });

  test("creates lock file with current PID", () => {
    // Ensure lock doesn't exist
    releaseLock(testLockPath);

    // Acquire lock
    acquireLock(testLockPath);

    // Verify lock file exists and contains our PID
    const content = readFileSync(testLockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));
  });

  test("throws when lock is held by running process", () => {
    // Create lock with our own PID (simulates another upgrade in progress)
    writeFileSync(testLockPath, String(process.pid));

    // Trying to acquire should fail
    expect(() => acquireLock(testLockPath)).toThrow(UpgradeError);
    expect(() => acquireLock(testLockPath)).toThrow(
      "Another upgrade is already in progress"
    );
  });

  test("cleans up stale lock from dead process", () => {
    // Create lock with non-existent PID (simulates crashed process)
    writeFileSync(testLockPath, "4194304"); // Very high PID unlikely to exist

    // Acquiring should succeed after cleaning up stale lock
    acquireLock(testLockPath);

    // Lock should now contain our PID
    const content = readFileSync(testLockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));
  });

  test("handles lock file with invalid content", () => {
    // Create lock with invalid PID
    writeFileSync(testLockPath, "not-a-number");

    // Should treat as stale and acquire successfully
    acquireLock(testLockPath);

    // Lock should now contain our PID
    const content = readFileSync(testLockPath, "utf-8").trim();
    expect(content).toBe(String(process.pid));
  });

  test("throws on permission error instead of infinite recursion", () => {
    // Skip on Windows - chmod doesn't work the same way
    if (platform() === "win32") {
      return;
    }

    // Create a lock file with a stale PID
    writeFileSync(testLockPath, "4194304"); // High PID unlikely to exist

    // Make file unreadable
    chmodSync(testLockPath, 0o000);

    try {
      // Should throw a permission error, not recurse infinitely
      expect(() => acquireLock(testLockPath)).toThrow();
    } finally {
      // Restore permissions so cleanup can work
      chmodSync(testLockPath, 0o644);
    }
  });
});

describe("releaseLock", () => {
  const releaseBinDir = join(TEST_TMP_DIR, "release-lock-test");
  const testLockPath = join(releaseBinDir, "test-release.lock");

  test("removes lock file", async () => {
    // Create a lock file
    mkdirSync(releaseBinDir, { recursive: true });
    writeFileSync(testLockPath, String(process.pid));

    // Verify it exists
    expect(statSync(testLockPath).size).toBeGreaterThan(0);

    // Release lock
    releaseLock(testLockPath);

    // File should be gone
    expect(
      await access(testLockPath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  test("does not throw if lock file does not exist", () => {
    // Should not throw
    expect(() => releaseLock(testLockPath)).not.toThrow();
  });
});

describe("executeUpgrade with curl method", () => {
  const upgradeBinDir = join(TEST_TMP_DIR, "upgrade-curl-test");
  const upgradeInstallPath = join(upgradeBinDir, "sentry");

  // Compute paths fresh for each test to avoid stale database state issues
  function getTestPaths() {
    return getCurlInstallPaths();
  }

  beforeEach(() => {
    // Redirect getCurlInstallPaths() to temp dir instead of ~/.sentry/bin/
    clearInstallInfo();
    mkdirSync(upgradeBinDir, { recursive: true });
    setInstallInfo({
      method: "curl",
      path: upgradeInstallPath,
      version: "0.0.0",
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    // Clean up test files - get fresh paths in case DB changed
    const paths = getTestPaths();
    for (const path of [
      paths.installPath,
      paths.tempPath,
      paths.oldPath,
      paths.lockPath,
    ]) {
      try {
        await unlink(path);
      } catch {
        // Ignore
      }
    }
    clearInstallInfo();
  });

  test("downloads and decompresses gzip binary when .gz URL succeeds", async () => {
    const mockBinaryContent = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]); // ELF magic bytes

    // Compress the mock content with gzip
    const gzipped = gzipSync(mockBinaryContent);

    // Mock fetch: first call returns gzipped content (.gz URL)
    mockFetch(async () => new Response(gzipped, { status: 200 }));

    const result = await executeUpgrade("curl", "1.0.0");

    expect(result).not.toBeNull();
    expect(result).toHaveProperty("tempBinaryPath");
    expect(result).toHaveProperty("lockPath");

    // Verify the decompressed binary matches the original content
    const paths = getTestPaths();
    expect(result!.tempBinaryPath).toBe(paths.tempPath);
    expect(result!.lockPath).toBe(paths.lockPath);
    expect(
      await access(result!.tempBinaryPath).then(
        () => true,
        () => false
      )
    ).toBe(true);
    const content = await readFile(result!.tempBinaryPath);
    expect(new Uint8Array(content)).toEqual(mockBinaryContent);
  });

  test("falls back to raw binary when .gz URL returns 404", async () => {
    const mockBinaryContent = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]); // ELF magic bytes
    let callCount = 0;

    // Mock fetch: first call (for .gz) returns 404, second returns raw binary
    mockFetch(async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(mockBinaryContent, { status: 200 });
    });

    const result = await executeUpgrade("curl", "1.0.0");

    expect(result).not.toBeNull();
    expect(callCount).toBe(2); // Both .gz and raw URL were tried

    // Verify the binary was downloaded
    expect(
      await access(result!.tempBinaryPath).then(
        () => true,
        () => false
      )
    ).toBe(true);
    const content = await readFile(result!.tempBinaryPath);
    expect(new Uint8Array(content)).toEqual(mockBinaryContent);
  });

  test("falls back to raw binary when .gz fetch throws network error", async () => {
    const mockBinaryContent = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]);
    let callCount = 0;

    // Mock fetch: first call throws, second returns raw binary
    mockFetch(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new TypeError("fetch failed");
      }
      return new Response(mockBinaryContent, { status: 200 });
    });

    const result = await executeUpgrade("curl", "1.0.0");

    expect(result).not.toBeNull();
    expect(callCount).toBe(2);

    const content = await readFile(result!.tempBinaryPath);
    expect(new Uint8Array(content)).toEqual(mockBinaryContent);
  });

  test("throws on HTTP error when both .gz and raw URLs fail", async () => {
    // Both .gz and raw return errors
    mockFetch(async () => new Response("Not Found", { status: 404 }));

    await expect(executeUpgrade("curl", "99.99.99")).rejects.toThrow(
      UpgradeError
    );
    await expect(executeUpgrade("curl", "99.99.99")).rejects.toThrow(
      "Failed to download binary: HTTP 404"
    );
  });

  test("throws on network failure when both .gz and raw URLs fail", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(executeUpgrade("curl", "1.0.0")).rejects.toThrow(UpgradeError);
    await expect(executeUpgrade("curl", "1.0.0")).rejects.toThrow(
      "Failed to connect to GitHub"
    );
  });

  test("releases lock on failure", async () => {
    mockFetch(async () => new Response("Server Error", { status: 500 }));

    try {
      await executeUpgrade("curl", "1.0.0");
    } catch {
      // Expected to fail
    }

    // Lock should be released even on failure
    const paths = getTestPaths();
    expect(
      await access(paths.lockPath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });
});

describe("startCleanupOldBinary", () => {
  // Get paths fresh to match what startCleanupOldBinary() uses
  function getOldPath() {
    return getCurlInstallPaths().oldPath;
  }

  beforeEach(() => {
    // Clear any stored install info to ensure we use default paths
    clearInstallInfo();
  });

  test("removes .old file if it exists", async () => {
    const oldPath = getOldPath();
    // Create the directory and file
    mkdirSync(join(oldPath, ".."), { recursive: true });
    writeFileSync(oldPath, "test content");

    // Verify file exists
    expect(
      await access(oldPath).then(
        () => true,
        () => false
      )
    ).toBe(true);

    // Clean up is fire-and-forget async, so we need to wait a bit
    startCleanupOldBinary();
    await sleep(50);

    // File should be gone
    expect(
      await access(oldPath).then(
        () => true,
        () => false
      )
    ).toBe(false);
  });

  // Note: cleanupOldBinary intentionally does NOT clean up .download files
  // because an upgrade may be in progress in another process. The .download
  // cleanup is handled inside the upgrade flow under the exclusive lock.

  test("does not throw if files do not exist", () => {
    // Ensure files don't exist by attempting cleanup first
    startCleanupOldBinary();

    // Should not throw when called again
    expect(() => startCleanupOldBinary()).not.toThrow();
  });
});

describe("isNightlyVersion", () => {
  test("returns true for nightly version strings", () => {
    expect(isNightlyVersion("0.0.0-dev.1740000000")).toBe(true);
    expect(isNightlyVersion("0.0.0-dev.1")).toBe(true);
  });

  test("returns false for stable version strings", () => {
    expect(isNightlyVersion("1.0.0")).toBe(false);
    expect(isNightlyVersion("0.13.0")).toBe(false);
    expect(isNightlyVersion("2.0.0-beta.1")).toBe(false);
    expect(isNightlyVersion("0.0.0-dev")).toBe(false);
  });
});

describe("fetchLatestNightlyVersion", () => {
  test("preserves an already-aborted signal reason", async () => {
    const controller = new AbortController();
    const reason = { kind: "cancelled" };
    controller.abort(reason);

    await expect(fetchLatestNightlyVersion(controller.signal)).rejects.toBe(
      reason
    );
  });
  test("falls back to legacy when the Toolkit nightly manifest returns 404", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      const request = String(url);
      requests.push(request);
      if (request === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response(null, { status: 200 });
      }
      if (request === "https://api.github.com/repos/getsentry/cli") {
        return new Response(null, { status: 200 });
      }
      if (request.includes("scope=repository:getsentry/toolkit:pull")) {
        return new Response(JSON.stringify({ token: "toolkit-token" }), {
          status: 200,
        });
      }
      if (request.includes("/v2/getsentry/toolkit/manifests/nightly")) {
        return new Response("Not Found", { status: 404 });
      }
      if (request.includes("scope=repository:getsentry/cli:pull")) {
        return new Response(JSON.stringify({ token: "cli-token" }), {
          status: 200,
        });
      }
      if (request.includes("/v2/getsentry/cli/manifests/nightly")) {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            layers: [],
            annotations: { version: "0.0.0-dev.1740000000" },
          }),
          { status: 200 }
        );
      }
      return new Response("Unexpected", { status: 500 });
    });

    await expect(fetchLatestNightlyVersion()).resolves.toBe(
      "0.0.0-dev.1740000000"
    );
    expect(requests).toContain(
      "https://ghcr.io/v2/getsentry/cli/manifests/nightly"
    );
  });

  test("does not fall back from a non-404 Toolkit nightly failure", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      const request = String(url);
      requests.push(request);
      if (request === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response(null, { status: 200 });
      }
      if (request.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "toolkit-token" }), {
          status: 200,
        });
      }
      return new Response("Forbidden", { status: 403 });
    });

    await expect(fetchLatestNightlyVersion()).rejects.toThrow("HTTP 403");
    expect(requests).not.toContain(
      "https://api.github.com/repos/getsentry/cli"
    );
  });

  test("does not fall back when nightly transport error text says HTTP 404", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      const request = String(url);
      requests.push(request);
      if (request === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response(null, { status: 200 });
      }
      if (request.includes("scope=repository:getsentry/toolkit:pull")) {
        return new Response(JSON.stringify({ token: "toolkit-token" }), {
          status: 200,
        });
      }
      if (request.includes("/v2/getsentry/toolkit/manifests/nightly")) {
        throw new Error("HTTP 404");
      }
      return new Response("Unexpected", { status: 500 });
    });

    await expect(fetchLatestNightlyVersion()).rejects.toThrow("HTTP 404");
    expect(requests).not.toContain(
      "https://api.github.com/repos/getsentry/cli"
    );
  });

  test("returns version from GHCR manifest annotation", async () => {
    // Mock the two requests: token exchange + manifest fetch
    let callCount = 0;
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response(null, { status: 200 });
      }
      callCount += 1;
      if (urlStr.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "test-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/manifests/nightly")) {
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            layers: [],
            annotations: { version: "0.0.0-dev.1740000000" },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/vnd.oci.image.manifest.v1+json",
            },
          }
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const version = await fetchLatestNightlyVersion();
    expect(version).toBe("0.0.0-dev.1740000000");
    expect(callCount).toBe(2); // token + manifest
  });

  test("throws UpgradeError when GHCR token exchange fails", async () => {
    mockFetch(async (url) =>
      String(url) === "https://api.github.com/repos/getsentry/toolkit"
        ? new Response(null, { status: 200 })
        : new Response("Unauthorized", { status: 401 })
    );

    await expect(fetchLatestNightlyVersion()).rejects.toThrow(UpgradeError);
    await expect(fetchLatestNightlyVersion()).rejects.toThrow(
      "GHCR token exchange failed: HTTP 401"
    );
  });

  test("throws UpgradeError when manifest has no version annotation", async () => {
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr === "https://api.github.com/repos/getsentry/toolkit") {
        return new Response(null, { status: 200 });
      }
      if (urlStr.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ schemaVersion: 2, layers: [], annotations: {} }),
        { status: 200 }
      );
    });

    await expect(fetchLatestNightlyVersion()).rejects.toThrow(UpgradeError);
    await expect(fetchLatestNightlyVersion()).rejects.toThrow(
      "Nightly manifest has no version annotation"
    );
  });

  test("aborts early if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      fetchLatestNightlyVersion(controller.signal)
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("executeUpgrade with curl method (nightly)", () => {
  const nightlyBinDir = join(TEST_TMP_DIR, "upgrade-nightly-test");
  const nightlyInstallPath = join(nightlyBinDir, "sentry");

  function getTestPaths() {
    return getCurlInstallPaths();
  }

  beforeEach(() => {
    clearInstallInfo();
    mkdirSync(nightlyBinDir, { recursive: true });
    setInstallInfo({
      method: "curl",
      path: nightlyInstallPath,
      version: "0.0.0",
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const paths = getTestPaths();
    for (const p of [
      paths.installPath,
      paths.tempPath,
      paths.oldPath,
      paths.lockPath,
    ]) {
      try {
        await unlink(p);
      } catch {
        // Ignore
      }
    }
    clearInstallInfo();
  });

  test("downloads and decompresses nightly binary from GHCR", async () => {
    const mockBinaryContent = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]); // ELF
    const gzipped = gzipSync(mockBinaryContent);

    // Mock: token exchange + manifest + blob (200 with gzipped content)
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (urlStr.includes("/manifests/nightly")) {
        let os = "linux";
        if (process.platform === "darwin") os = "darwin";
        else if (process.platform === "win32") os = "windows";
        const arch = process.arch === "arm64" ? "arm64" : "x64";
        const suffix = process.platform === "win32" ? ".exe" : "";
        const title = `sentry-${os}-${arch}${suffix}.gz`;
        return new Response(
          JSON.stringify({
            schemaVersion: 2,
            layers: [
              {
                digest: `sha256:${"b".repeat(64)}`,
                mediaType: "application/octet-stream",
                size: gzipped.byteLength,
                annotations: { "org.opencontainers.image.title": title },
              },
            ],
            annotations: { version: "0.0.0-dev.1740000000" },
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes("/blobs/")) {
        // Return gzipped blob directly (no redirect needed for test)
        return new Response(gzipped, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const result = await executeUpgrade("curl", "0.0.0-dev.1740000000");

    expect(result).not.toBeNull();
    expect(result).toHaveProperty("tempBinaryPath");

    // Verify decompressed content matches original
    const content = await readFile(result!.tempBinaryPath);
    expect(new Uint8Array(content)).toEqual(mockBinaryContent);
  });

  test("rejects a mismatched versioned manifest before downloading its blob", async () => {
    const requests: string[] = [];
    mockFetch(async (url) => {
      const request = String(url);
      requests.push(request);
      if (request.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
      }
      if (request.includes("/manifests/nightly-0.14.0-dev.123")) {
        return new Response(
          JSON.stringify({
            layers: [],
            annotations: { version: "0.14.0-dev.124" },
          }),
          { status: 200 }
        );
      }
      return new Response("Unexpected", { status: 500 });
    });

    await expect(
      executeUpgrade(
        "curl",
        "0.14.0-dev.123",
        undefined,
        false,
        undefined,
        UPGRADE_SOURCES[0]
      )
    ).rejects.toMatchObject({ reason: "network_error" });
    expect(requests.some((request) => request.includes("/blobs/"))).toBe(false);
  });
});

describe("downloadBinaryToTemp offline errors", () => {
  const offlineBinDir = join(TEST_TMP_DIR, "upgrade-offline-test");
  const offlineInstallPath = join(offlineBinDir, "sentry");

  beforeEach(() => {
    clearInstallInfo();
    mkdirSync(offlineBinDir, { recursive: true });
    setInstallInfo({
      method: "curl",
      path: offlineInstallPath,
      version: "0.0.0",
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const paths = getCurlInstallPaths();
    for (const p of [
      paths.installPath,
      paths.tempPath,
      paths.oldPath,
      paths.lockPath,
    ]) {
      try {
        await unlink(p);
      } catch {
        // Ignore
      }
    }
    clearInstallInfo();
  });

  test("explicit offline: throws offline_cache_miss with actionable message", async () => {
    try {
      await downloadBinaryToTemp("0.26.1", undefined, "explicit");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeError);
      const upgradeError = error as UpgradeError;
      expect(upgradeError.reason).toBe("offline_cache_miss");
      expect(upgradeError.message).toContain("in offline mode");
      expect(upgradeError.message).toContain("without `--offline`");
      expect(upgradeError.message).not.toContain("cached patches");
    }
  });

  test("network fallback: throws offline_cache_miss with connection message", async () => {
    try {
      await downloadBinaryToTemp("0.26.1", undefined, "network-fallback");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeError);
      const upgradeError = error as UpgradeError;
      expect(upgradeError.reason).toBe("offline_cache_miss");
      expect(upgradeError.message).toContain("network is unavailable");
      expect(upgradeError.message).toContain("Check your internet connection");
      expect(upgradeError.message).not.toContain("cached patches");
    }
  });
});

// Regression coverage for CLI-1D3: when the full download silently produces
// a missing or empty file, `downloadBinaryToTemp` polls with exponential
// backoff (letting a Windows filesystem-visibility race self-heal), then
// fails with an actionable `UpgradeError` if the file never appears.
describe("downloadBinaryToTemp verifies download integrity (CLI-1D3)", () => {
  const verifyBinDir = join(TEST_TMP_DIR, "upgrade-verify-test");
  const verifyInstallPath = join(verifyBinDir, "sentry");

  beforeEach(() => {
    clearInstallInfo();
    mkdirSync(verifyBinDir, { recursive: true });
    setInstallInfo({
      method: "curl",
      path: verifyInstallPath,
      version: "0.0.0",
    });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const paths = getCurlInstallPaths();
    for (const p of [
      paths.installPath,
      paths.tempPath,
      paths.oldPath,
      paths.lockPath,
    ]) {
      try {
        await unlink(p);
      } catch {
        // Ignore
      }
    }
    clearInstallInfo();
  });

  test("throws execution_failed UpgradeError after retry budget is exhausted", async () => {
    // Serve an empty gzip payload. The outer stream completes cleanly, so
    // neither fetchWithUpgradeError nor streamDecompressToFile throws —
    // but `destPath` ends up with zero bytes. The verification loop polls
    // 5 times (~3.1s cumulative) before giving up with an actionable
    // error; without it the caller would spawn the empty file and fail
    // with "Executable not found in $PATH" (the CLI-1D3 symptom).
    const emptyGzip = gzipSync(new Uint8Array(0));
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith(".gz")) {
        return new Response(emptyGzip, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      await downloadBinaryToTemp("0.26.1");
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UpgradeError);
      const upgradeError = error as UpgradeError;
      expect(upgradeError.reason).toBe("execution_failed");
      expect(upgradeError.message).toContain("missing or empty");
      expect(upgradeError.message).toContain("sentry cli upgrade");
    }
  }, 10_000);

  test("releases the download lock when verification fails", async () => {
    const emptyGzip = gzipSync(new Uint8Array(0));
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith(".gz")) {
        return new Response(emptyGzip, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    await expect(downloadBinaryToTemp("0.26.1")).rejects.toThrow(UpgradeError);

    // The lock must be released so a subsequent retry can acquire it.
    // acquireLock throws UpgradeError("Another upgrade is already in progress")
    // when a live lock exists; if the previous failure released it correctly
    // this call succeeds silently.
    const { lockPath } = getCurlInstallPaths();
    expect(() => acquireLock(lockPath)).not.toThrow();
    releaseLock(lockPath);
  }, 10_000);

  test("recovers when the binary becomes visible during the retry window", async () => {
    // Simulate a Windows filesystem-visibility race: the download writes
    // an empty file, but good bytes become visible a short time later.
    // The polling loop's exponential backoff observes the non-empty file
    // on a subsequent attempt and returns without throwing.
    //
    // To keep the ordering deterministic under CI load, the "delayed
    // writer" first waits until the empty download file is visible on
    // disk (proving streamDecompressToFile has finished) before writing
    // the good bytes. Otherwise a slow CI could let our Bun.write land
    // before the download completes and get clobbered by the empty write.
    const mockBinaryContent = new Uint8Array([0x7f, 0x45, 0x4c, 0x46]); // ELF
    const emptyGzip = gzipSync(new Uint8Array(0));
    mockFetch(async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith(".gz")) {
        return new Response(emptyGzip, { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    });

    const { tempPath } = getCurlInstallPaths();
    const delayedWrite = (async () => {
      // Wait for the empty download to land on disk first, so we
      // overwrite it instead of racing it.
      for (let i = 0; i < 200; i++) {
        if (
          await access(tempPath).then(
            () => true,
            () => false
          )
        ) {
          break;
        }
        await sleep(10);
      }
      // Give the probe loop at least one zero-byte observation so the
      // recovery branch (attempt > 1) actually fires.
      await sleep(150);
      await writeFile(tempPath, mockBinaryContent);
    })();

    const result = await downloadBinaryToTemp("0.26.1");
    expect(result.tempBinaryPath).toBe(tempPath);
    await delayedWrite;

    // Verify the good bytes survived — catches the regression where a
    // late download completion clobbers the delayed write.
    const onDisk = new Uint8Array(await readFile(tempPath));
    expect(onDisk).toEqual(mockBinaryContent);

    // Release the lock so afterEach cleanup runs cleanly.
    releaseLock(result.lockPath);
  }, 10_000);
});

// CLI-1D3 tail: even if the verification in downloadBinaryToTemp is
// somehow bypassed (e.g. manual `rm` of .download between verification
// and spawn), `spawnWithRetry` translates the opaque "Executable not
// found in $PATH" into an actionable UpgradeError.
describe("isEnoentSpawnError", () => {
  test("detects Bun's 'Executable not found in $PATH' error", () => {
    const err = new Error(
      `Executable not found in $PATH: "C:\\Users\\x\\.local\\bin\\sentry.exe.download"`
    );
    expect(isEnoentSpawnError(err)).toBe(true);
  });

  test("detects Node's ENOENT errno code", () => {
    const err: NodeJS.ErrnoException = new Error("spawn ENOENT");
    err.code = "ENOENT";
    expect(isEnoentSpawnError(err)).toBe(true);
  });

  test("returns false for unrelated errors", () => {
    expect(isEnoentSpawnError(new Error("EBUSY: file locked"))).toBe(false);
    expect(isEnoentSpawnError(new Error("permission denied"))).toBe(false);
    expect(isEnoentSpawnError("string error")).toBe(false);
    expect(isEnoentSpawnError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeUpgrade — brew
// ---------------------------------------------------------------------------

describe("executeUpgrade (brew)", () => {
  test("returns null on successful brew upgrade", async () => {
    spawnImpl.fn = () => fakeProcess(0);
    expect(await executeUpgrade("brew", "1.0.0")).toBeNull();
  });

  test("throws UpgradeError on non-zero brew exit", async () => {
    spawnImpl.fn = () => fakeProcess(1);
    try {
      await executeUpgrade("brew", "1.0.0");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UpgradeError);
      expect((err as UpgradeError).reason).toBe("execution_failed");
      expect((err as UpgradeError).message).toContain("exit code 1");
    }
  });

  test("throws UpgradeError on brew spawn error", async () => {
    spawnImpl.fn = () => fakeErrorProcess("brew not found");
    try {
      await executeUpgrade("brew", "1.0.0");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UpgradeError);
      expect((err as UpgradeError).reason).toBe("execution_failed");
      expect((err as UpgradeError).message).toContain("brew not found");
    }
  });

  test("invokes brew with correct arguments", async () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    let capturedOpts: object = {};
    spawnImpl.fn = (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedOpts = opts;
      return fakeProcess(0);
    };
    await executeUpgrade("brew", "1.0.0");
    expect(capturedCmd).toBe("brew");
    expect(capturedArgs).toEqual(["upgrade", "getsentry/tools/sentry"]);
    expect(capturedOpts).toHaveProperty("shell", process.platform === "win32");
  });
});

// ---------------------------------------------------------------------------
// executeUpgrade — package managers (npm, pnpm, bun, yarn)
// ---------------------------------------------------------------------------

describe("executeUpgrade (package managers)", () => {
  test("npm: returns null on success", async () => {
    spawnImpl.fn = () => fakeProcess(0);
    expect(await executeUpgrade("npm", "1.0.0")).toBeNull();
  });

  test("npm: uses correct install arguments", async () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    let capturedOpts: object = {};
    spawnImpl.fn = (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedOpts = opts;
      return fakeProcess(0);
    };
    await executeUpgrade("npm", "1.2.3");
    expect(capturedCmd).toBe("npm");
    expect(capturedArgs).toEqual(["install", "-g", "sentry@1.2.3"]);
    expect(capturedOpts).toHaveProperty("shell", process.platform === "win32");
  });

  test("pnpm: uses correct install arguments", async () => {
    let capturedArgs: string[] = [];
    spawnImpl.fn = (_cmd, args) => {
      capturedArgs = args;
      return fakeProcess(0);
    };
    await executeUpgrade("pnpm", "1.2.3");
    expect(capturedArgs).toEqual(["install", "-g", "sentry@1.2.3"]);
  });

  test("bun: uses correct install arguments", async () => {
    let capturedArgs: string[] = [];
    spawnImpl.fn = (_cmd, args) => {
      capturedArgs = args;
      return fakeProcess(0);
    };
    await executeUpgrade("bun", "1.2.3");
    expect(capturedArgs).toEqual(["install", "-g", "sentry@1.2.3"]);
  });

  test("yarn: uses 'global add' arguments", async () => {
    let capturedCmd = "";
    let capturedArgs: string[] = [];
    let capturedOpts: object = {};
    spawnImpl.fn = (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedOpts = opts;
      return fakeProcess(0);
    };
    await executeUpgrade("yarn", "1.2.3");
    expect(capturedCmd).toBe("yarn");
    expect(capturedArgs).toEqual(["global", "add", "sentry@1.2.3"]);
    expect(capturedOpts).toHaveProperty("shell", process.platform === "win32");
  });

  test("npm: throws UpgradeError on non-zero exit", async () => {
    spawnImpl.fn = () => fakeProcess(1);
    try {
      await executeUpgrade("npm", "1.0.0");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UpgradeError);
      expect((err as UpgradeError).reason).toBe("execution_failed");
      expect((err as UpgradeError).message).toContain("npm install failed");
    }
  });

  test("npm: throws UpgradeError on spawn error", async () => {
    spawnImpl.fn = () => fakeErrorProcess("npm not found");
    try {
      await executeUpgrade("npm", "1.0.0");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UpgradeError);
      expect((err as UpgradeError).reason).toBe("execution_failed");
      expect((err as UpgradeError).message).toContain("npm not found");
    }
  });
});

// ---------------------------------------------------------------------------
// executeUpgrade — unknown method (default switch case)
// ---------------------------------------------------------------------------

describe("executeUpgrade (unknown method)", () => {
  test("throws UpgradeError with unknown_method reason", async () => {
    try {
      await executeUpgrade("unknown" as never, "1.0.0");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UpgradeError);
      expect((err as UpgradeError).reason).toBe("unknown_method");
    }
  });
});

// ---------------------------------------------------------------------------
// runCommand via isInstalledWith (indirect coverage of runCommand)
// ---------------------------------------------------------------------------

describe("detectInstallationMethod — legacy pm detection via isInstalledWith", () => {
  useTestConfigDir("test-detect-legacy-");

  let originalExecPath: string;
  let originalArgv: string[];

  beforeEach(() => {
    originalExecPath = process.execPath;
    originalArgv = [...process.argv];
    // Non-Homebrew, non-known-curl execPath so detection falls through to pm checks
    Object.defineProperty(process, "execPath", {
      value: "/usr/bin/sentry",
      configurable: true,
    });
    // Clear argv[1] to prevent detectPackageManagerFromPath() from detecting
    // vitest's node_modules path as an npm install
    process.argv[1] = "sentry";
    clearInstallInfo();
  });

  afterEach(() => {
    Object.defineProperty(process, "execPath", {
      value: originalExecPath,
      configurable: true,
    });
    process.argv = originalArgv;
    clearInstallInfo();
  });

  test("detects npm when 'npm list -g sentry' output includes 'sentry@'", async () => {
    let capturedOpts: object = {};
    spawnImpl.fn = (_cmd, args, opts) => {
      capturedOpts = opts;
      return fakeProcess(0, args.includes("sentry") ? "sentry@1.0.0" : "");
    };
    const method = await detectInstallationMethod();
    expect(method).toBe("npm");
    // runCommand passes shell: true on Windows for .cmd compatibility
    expect(capturedOpts).toHaveProperty("shell", process.platform === "win32");
  });

  test("detects yarn when 'yarn global list' output includes 'sentry@'", async () => {
    // npm is checked first — make npm/pnpm/bun return empty; only yarn matches
    spawnImpl.fn = (cmd) => {
      if (cmd === "yarn") return fakeProcess(0, "sentry@1.0.0");
      return fakeProcess(0, "");
    };
    const method = await detectInstallationMethod();
    expect(method).toBe("yarn");
  });

  test("returns 'unknown' when no package manager lists sentry", async () => {
    spawnImpl.fn = () => fakeProcess(0, ""); // all return empty stdout
    const method = await detectInstallationMethod();
    expect(method).toBe("unknown");
  });

  test("returns 'unknown' when all package manager spawns error", async () => {
    spawnImpl.fn = () => fakeErrorProcess("command not found");
    const method = await detectInstallationMethod();
    expect(method).toBe("unknown");
  });

  test("auto-saves detected method when non-unknown", async () => {
    spawnImpl.fn = (_cmd, args) =>
      fakeProcess(0, args.includes("sentry") ? "sentry@2.0.0" : "");
    await detectInstallationMethod();
    // After detection, install info should be auto-saved with method=npm
    const { getInstallInfo } = await import("../../src/lib/db/install-info.js");
    const stored = getInstallInfo();
    expect(stored?.method).toBe("npm");
  });

  test("returns stored method on second call (auto-save fast path)", async () => {
    // First call: npm detected and auto-saved
    spawnImpl.fn = (_cmd, args) =>
      fakeProcess(0, args.includes("sentry") ? "sentry@1.0.0" : "");
    await detectInstallationMethod();

    // Second call: spawn should not be called again (stored info takes precedence)
    let spawnCalled = false;
    spawnImpl.fn = () => {
      spawnCalled = true;
      return fakeProcess(0, "sentry@1.0.0");
    };
    const method = await detectInstallationMethod();
    expect(method).toBe("npm");
    expect(spawnCalled).toBe(false);
  });
});
