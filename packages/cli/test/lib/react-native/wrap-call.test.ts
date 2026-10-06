/**
 * Tests for the React Native Xcode build wrapper (`wrap_call`).
 *
 * The wrapped Node/Hermes spawn is mocked; the tests assert argument parsing,
 * the JSON report contents, and the Hermes debug-id copy.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SourceMapReport } from "../../../src/lib/react-native/wrap-call.js";
import { wrapCall } from "../../../src/lib/react-native/wrap-call.js";

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
let reportPath: string;
const origArgv = process.argv;

/** Simulate the RN build script invoking us with these args (non-SEA layout). */
function setArgs(args: string[]): void {
  process.argv = ["node", "bin.js", ...args];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rn-wrap-"));
  reportPath = join(dir, "report.json");
  spawnMock.mockClear();
});
afterEach(() => {
  process.argv = origArgv;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function readReport(): SourceMapReport {
  return JSON.parse(readFileSync(reportPath, "utf-8")) as SourceMapReport;
}

describe("wrapCall", () => {
  test("parses a bundle command and adds a --sourcemap-output", () => {
    setArgs(["cli.js", "bundle", "--bundle-output", "/build/app.jsbundle"]);
    const status = wrapCall({
      SENTRY_RN_SOURCEMAP_REPORT: reportPath,
      SENTRY_RN_REAL_NODE_BINARY: "node",
    });

    expect(status).toBe(0);
    const report = readReport();
    expect(report.packager_bundle_path).toBe("/build/app.jsbundle");
    expect(report.packager_sourcemap_path).toContain("app.jsbundle.map");
    // The real node was invoked with the injected --sourcemap-output.
    const [exe, args] = spawnMock.mock.calls[0];
    expect(exe).toBe("node");
    expect(args).toContain("--sourcemap-output");
  });

  test("records the Hermes bundle path from -emit-binary", () => {
    setArgs(["-emit-binary", "-out", "/build/app.hbc", "/build/app.js"]);
    wrapCall({
      SENTRY_RN_SOURCEMAP_REPORT: reportPath,
      SENTRY_RN_REAL_NODE_BINARY: "node",
      SENTRY_RN_REAL_HERMES_CLI_PATH: "/hermesc",
    });
    expect(spawnMock.mock.calls[0][0]).toBe("/hermesc");
    expect(readReport().hermes_bundle_path).toBe("/build/app.hbc");
  });

  test("copies the debug id into the Hermes combined sourcemap", () => {
    const pkgMap = join(dir, "packager.map");
    const hermesMap = join(dir, "hermes.map");
    writeFileSync(pkgMap, JSON.stringify({ version: 3, debugId: "abc-123" }));
    writeFileSync(hermesMap, JSON.stringify({ version: 3 }));
    // Seed the report with the packager sourcemap path (from a prior bundle call).
    writeFileSync(
      reportPath,
      JSON.stringify({ packager_sourcemap_path: pkgMap })
    );

    setArgs(["/tools/compose-source-maps.js", "-o", hermesMap]);
    wrapCall({
      SENTRY_RN_SOURCEMAP_REPORT: reportPath,
      SENTRY_RN_REAL_NODE_BINARY: "node",
    });

    const hermes = JSON.parse(readFileSync(hermesMap, "utf-8"));
    expect(hermes.debugId).toBe("abc-123");
    expect(hermes.debug_id).toBe("abc-123");
    expect(readReport().hermes_sourcemap_path).toBe(hermesMap);
  });

  test("reports a non-zero status when the child is killed by a signal", () => {
    spawnMock.mockReturnValueOnce({
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      pid: 1,
      output: [],
    } as unknown as ReturnType<typeof spawnSync>);
    setArgs(["cli.js", "bundle", "--bundle-output", "/build/app.jsbundle"]);
    const status = wrapCall({
      SENTRY_RN_SOURCEMAP_REPORT: reportPath,
      SENTRY_RN_REAL_NODE_BINARY: "node",
    });
    expect(status).not.toBe(0);
  });

  test("respects SENTRY_RN_NO_DEBUG_ID", () => {
    const pkgMap = join(dir, "packager.map");
    const hermesMap = join(dir, "hermes.map");
    writeFileSync(pkgMap, JSON.stringify({ debugId: "abc-123" }));
    writeFileSync(hermesMap, JSON.stringify({ version: 3 }));
    writeFileSync(
      reportPath,
      JSON.stringify({ packager_sourcemap_path: pkgMap })
    );

    setArgs(["/tools/compose-source-maps.js", "-o", hermesMap]);
    wrapCall({
      SENTRY_RN_SOURCEMAP_REPORT: reportPath,
      SENTRY_RN_REAL_NODE_BINARY: "node",
      SENTRY_RN_NO_DEBUG_ID: "1",
    });

    expect(
      JSON.parse(readFileSync(hermesMap, "utf-8")).debugId
    ).toBeUndefined();
  });
});
