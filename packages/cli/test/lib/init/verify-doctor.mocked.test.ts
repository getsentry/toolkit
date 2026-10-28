/**
 * Doctor-based verification tests with child_process mocked before import.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TEST_TMP_DIR } from "../../constants.js";
import { createMockUI } from "./ui/mock-ui.js";

const mocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  setTag: vi.fn(),
  spawnCalls: [] as Array<{
    command: string;
    args: string[];
    options: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      shell?: boolean;
    };
  }>,
  whichSync: vi.fn((cmd: string) => (cmd === "missing" ? null : `/bin/${cmd}`)),
  nextExitCode: 0 as number,
  nextStdout: "" as string,
  nextStderr: "" as string,
  spawnError: null as Error | null,
}));

vi.mock("@sentry/node-core/light", () => ({
  addBreadcrumb: mocks.addBreadcrumb,
  captureException: mocks.captureException,
  setTag: mocks.setTag,
}));

vi.mock("../../../src/lib/which.js", () => ({
  whichSync: mocks.whichSync,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    spawn: vi.fn(
      (
        command: string,
        args: string[],
        options: { cwd?: string; env?: Record<string, string | undefined> },
      ) => {
        mocks.spawnCalls.push({ command, args, options });
        if (mocks.spawnError) {
          throw mocks.spawnError;
        }
        const child = Object.assign(new EventEmitter(), {
          exitCode: null as number | null,
          kill: (_signal: NodeJS.Signals) => true,
          pid: 4242,
          stderr: new PassThrough(),
          stdout: new PassThrough(),
        });
        queueMicrotask(() => {
          if (mocks.nextStdout) {
            child.stdout.write(`${mocks.nextStdout}\n`);
          }
          if (mocks.nextStderr) {
            child.stderr.write(`${mocks.nextStderr}\n`);
          }
          child.exitCode = mocks.nextExitCode;
          child.emit("close", mocks.nextExitCode);
        });
        return child;
      },
    ),
  };
});

import { verifyWithDoctor } from "../../../src/lib/init/verify-doctor.js";
import { verifySetup } from "../../../src/lib/init/verify-setup.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(TEST_TMP_DIR, "verify-doctor-"));
  mocks.addBreadcrumb.mockClear();
  mocks.captureException.mockClear();
  mocks.setTag.mockClear();
  mocks.spawnCalls.length = 0;
  mocks.whichSync.mockImplementation((cmd: string) =>
    cmd === "missing" ? null : `/bin/${cmd}`,
  );
  mocks.nextExitCode = 0;
  mocks.nextStdout =
    "Doctor summary (to see all details, run flutter doctor -v):";
  mocks.nextStderr = "";
  mocks.spawnError = null;
});

// Keep the long fixture string readable without wrapping mid-sentence.
const EXPO_FAIL_STDOUT =
  "14/15 checks passed. 1 checks failed. See above for details.";

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("verifyWithDoctor", () => {
  test("reports success when flutter doctor exits 0", async () => {
    const { ui, calls } = createMockUI();
    const outcome = await verifyWithDoctor(
      {
        kind: "doctor",
        tool: "flutter",
        args: ["flutter", "doctor"],
        source: "wizard.platform=flutter",
      },
      { status: "success", result: { platform: "flutter" } },
      ui,
      tmpDir,
    );

    expect(mocks.spawnCalls[0]).toMatchObject({
      command: "flutter",
      args: ["doctor"],
    });
    expect(calls).toContainEqual({
      kind: "log.success",
      message: "Verified — flutter doctor passed",
    });
    expect(outcome).toEqual({ verified: false, kind: "doctor_passed" });
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  test("runs batch-file doctor commands through a shell on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { ui } = createMockUI();
      await verifyWithDoctor(
        {
          kind: "doctor",
          tool: "expo",
          args: ["npx.cmd", "expo", "doctor"],
          source: "wizard.platform=react-native",
        },
        { status: "success", result: { platform: "react-native" } },
        ui,
        tmpDir,
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }

    expect(mocks.spawnCalls[0]).toMatchObject({
      command: "npx.cmd",
      args: ["expo", "doctor"],
      options: { shell: true },
    });
  });

  test("reports failure and captures telemetry when expo doctor fails", async () => {
    mocks.nextExitCode = 1;
    mocks.nextStdout = EXPO_FAIL_STDOUT;
    const { ui, calls } = createMockUI();

    const outcome = await verifyWithDoctor(
      {
        kind: "doctor",
        tool: "expo",
        args: ["npx", "expo", "doctor"],
        source: "expo project markers",
      },
      { status: "success", result: { platform: "javascript-expo" } },
      ui,
      tmpDir,
    );

    expect(outcome).toEqual({ verified: false, kind: "doctor_failed" });
    expect(calls.some((c) => c.kind === "log.warn")).toBe(true);
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "init verification failed" }),
      expect.objectContaining({
        tags: expect.objectContaining({
          "wizard.verify": "doctor_failed",
          "wizard.platform": "javascript-expo",
        }),
        extra: expect.objectContaining({
          doctorTool: "expo",
          exitCode: 1,
        }),
      }),
    );
  });

  test("skips without an error event when flutter is missing from PATH", async () => {
    mocks.whichSync.mockReturnValue(null);
    const { ui, calls } = createMockUI();

    const outcome = await verifyWithDoctor(
      {
        kind: "doctor",
        tool: "flutter",
        args: ["flutter", "doctor"],
        source: "pubspec.yaml",
      },
      { status: "success", result: { platform: "flutter" } },
      ui,
      tmpDir,
    );

    expect(mocks.spawnCalls).toHaveLength(0);
    expect(calls).toContainEqual({
      kind: "log.info",
      message: "Skipping verification — flutter is not on PATH",
    });
    expect(outcome).toEqual({ verified: false, kind: "skipped" });
    // Expected skips are breadcrumbs, not ERROR events.
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ message: "skipped:no_flutter" }),
    );
    expect(mocks.setTag).toHaveBeenCalledWith("wizard.verify", "skipped");
  });
});

describe("verifySetup", () => {
  test("routes Flutter projects to flutter doctor instead of a dev server", async () => {
    const { ui, calls } = createMockUI();

    const outcome = await verifySetup(
      { status: "success", result: { platform: "flutter" } },
      ui,
      tmpDir,
    );

    expect(mocks.spawnCalls).toHaveLength(1);
    expect(mocks.spawnCalls[0]).toMatchObject({
      command: "flutter",
      args: ["doctor"],
    });
    expect(calls).toContainEqual({
      kind: "log.success",
      message: "Verified — flutter doctor passed",
    });
    expect(outcome).toEqual({ verified: false, kind: "doctor_passed" });
  });
});
