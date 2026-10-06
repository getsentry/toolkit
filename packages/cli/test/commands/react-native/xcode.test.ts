/**
 * Tests for `sentry react-native xcode` mode selection.
 *
 * The build-script spawn, sourcemap upload, org/project resolution, and debug-id
 * injection are mocked so the three modes (need-Xcode error, debug passthrough,
 * release wrap+upload) can be exercised off-device.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { xcodeCommand } from "../../../src/commands/react-native/xcode.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as sourcemaps from "../../../src/lib/api/sourcemaps.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(() => ({
      status: 0,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    })),
  };
});

const spawnMock = vi.mocked(spawnSync);

let dir: string;
let script: string;

function createContext(env: NodeJS.ProcessEnv) {
  return {
    stdout: { write: () => true },
    stderr: { write: () => true },
    cwd: dir,
    env,
    process: { ...process, execPath: "/usr/bin/sentry", exitCode: undefined },
  } as unknown as Parameters<
    Awaited<ReturnType<typeof xcodeCommand.loader>>
  >[0];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rn-xcode-"));
  script = join(dir, "react-native-xcode.sh");
  writeFileSync(script, "#!/bin/sh\ntrue\n");
  spawnMock.mockClear();
  vi.spyOn(resolveTarget, "resolveOrgAndProject").mockResolvedValue({
    org: "acme",
    project: "mobile",
  });
  vi.spyOn(sourcemaps, "uploadSourcemaps").mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

async function runXcode(env: NodeJS.ProcessEnv, flags = {}): Promise<void> {
  const func = await xcodeCommand.loader();
  await func.call(createContext(env), { "build-script": script, ...flags });
}

describe("react-native xcode", () => {
  test("errors when not run from Xcode", async () => {
    await expect(runXcode({})).rejects.toThrow(/from Xcode/);
  });

  test("debug build just runs the script (no upload)", async () => {
    await runXcode({ CONFIGURATION: "Debug" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe(script);
    expect(sourcemaps.uploadSourcemaps).not.toHaveBeenCalled();
  });

  test("release build wraps, reads the report, and uploads", async () => {
    const bundle = join(dir, "main.jsbundle");
    const map = join(dir, "main.jsbundle.map");
    // The wrapped build "produces" a report pointing at the bundle + sourcemap.
    spawnMock.mockImplementation(
      (
        _cmd: string,
        _args: readonly string[] | undefined,
        spawnOpts?: { env?: NodeJS.ProcessEnv }
      ) => {
        const reportPath = spawnOpts?.env?.SENTRY_RN_SOURCEMAP_REPORT;
        if (reportPath) {
          writeFileSync(
            reportPath,
            JSON.stringify({
              packager_bundle_path: bundle,
              packager_sourcemap_path: map,
            })
          );
        }
        return {
          status: 0,
          stdout: "",
          stderr: "",
          pid: 1,
          output: [],
          signal: null,
        };
      }
    );

    // The sourcemap already carries a debug id (from the Metro plugin).
    writeFileSync(map, JSON.stringify({ version: 3, debugId: "dead-beef" }));

    await runXcode({
      CONFIGURATION: "Release",
      SENTRY_RELEASE: "app@1.0.0",
      SENTRY_DIST: "42",
    });

    // Non-SEA (npm) run: NODE_BINARY must re-invoke the CLI via a shim, not
    // plain node, so RN re-enters the wrapper.
    const wrapEnv = spawnMock.mock.calls[0][2]?.env;
    expect(wrapEnv?.NODE_BINARY).toMatch(/sentry-rn-node\.sh$/);
    expect(wrapEnv?.__SENTRY_RN_WRAP_XCODE_CALL).toBe("1");

    expect(sourcemaps.uploadSourcemaps).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(sourcemaps.uploadSourcemaps).mock
      .calls[0][0] as sourcemaps.UploadOptions;
    expect(opts).toMatchObject({
      org: "acme",
      project: "mobile",
      release: "app@1.0.0",
      dist: "42",
    });
    expect(opts.files.map((f) => f.url)).toEqual([
      "~/main.jsbundle",
      "~/main.jsbundle.map",
    ]);
    // The debug id comes from the sourcemap — the bundle is never mutated.
    expect(opts.files.every((f) => f.debugId === "dead-beef")).toBe(true);
  });

  test("does not upload when the wrapped build fails", async () => {
    spawnMock.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
      signal: null,
    });
    await runXcode({ CONFIGURATION: "Release" });
    expect(sourcemaps.uploadSourcemaps).not.toHaveBeenCalled();
  });

  test.each([
    ["missing", 0],
    ["missing", 7],
    ["malformed", 0],
    ["malformed", 7],
  ] as const)("skips upload for a %s report and preserves build status %i", async (reportState, status) => {
    spawnMock.mockImplementation(
      (
        _cmd: string,
        _args: readonly string[] | undefined,
        spawnOpts?: { env?: NodeJS.ProcessEnv }
      ) => {
        const reportPath = spawnOpts?.env?.SENTRY_RN_SOURCEMAP_REPORT;
        if (reportPath) {
          if (reportState === "missing") {
            rmSync(reportPath);
          } else {
            writeFileSync(reportPath, '{"packager_bundle_path":');
          }
        }
        return {
          status,
          stdout: "",
          stderr: "",
          pid: 1,
          output: [],
          signal: null,
        };
      }
    );

    const ctx = createContext({ CONFIGURATION: "Release" });
    const func = await xcodeCommand.loader();
    await func.call(ctx, { "build-script": script });

    expect(ctx.process.exitCode).toBe(status === 0 ? undefined : status);
    expect(sourcemaps.uploadSourcemaps).not.toHaveBeenCalled();
  });

  test("warns and skips upload when the build produced no sourcemaps", async () => {
    spawnMock.mockImplementation(
      (
        _cmd: string,
        _args: readonly string[] | undefined,
        spawnOpts?: { env?: NodeJS.ProcessEnv }
      ) => {
        const reportPath = spawnOpts?.env?.SENTRY_RN_SOURCEMAP_REPORT;
        if (reportPath) {
          writeFileSync(reportPath, "{}");
        }
        return {
          status: 0,
          stdout: "",
          stderr: "",
          pid: 1,
          output: [],
          signal: null,
        };
      }
    );
    await runXcode({ CONFIGURATION: "Release" });
    expect(sourcemaps.uploadSourcemaps).not.toHaveBeenCalled();
  });
});
