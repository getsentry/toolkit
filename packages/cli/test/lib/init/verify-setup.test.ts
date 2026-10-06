import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { verifySetup } from "../../../src/lib/init/verify-setup.js";
import { TEST_TMP_DIR } from "../../constants.js";
import { createMockUI } from "./ui/mock-ui.js";

const sentryMocks = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  setTag: vi.fn(),
}));

vi.mock("@sentry/node-core/light", () => sentryMocks);

type FixtureProcesses = {
  shellPid: number;
  parentPid: number;
  childPid: number;
};

let tmpDir: string;
let fixtureProcesses: FixtureProcesses | undefined;

beforeEach(async () => {
  sentryMocks.addBreadcrumb.mockClear();
  sentryMocks.captureException.mockClear();
  sentryMocks.setTag.mockClear();
  tmpDir = await mkdtemp(join(TEST_TMP_DIR, "verify-setup-test-"));
});

afterEach(async () => {
  if (fixtureProcesses) {
    for (const pid of [
      fixtureProcesses.shellPid,
      fixtureProcesses.parentPid,
      fixtureProcesses.childPid,
    ]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The verification cleanup should already have terminated the fixture.
      }
    }
  }
  await rm(tmpDir, { recursive: true, force: true });
  fixtureProcesses = undefined;
});

/** Return whether a process currently exists. */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Wait for a short, bounded interval. */
async function wait(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

/** Wait briefly for a killed process to be reaped by the operating system. */
async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2000;
  while (processExists(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await wait(25);
  }
  return true;
}

/** Write a shell-based dev script that leaves a process tree holding stdio. */
async function writeProcessTreeFixture(ignoreSigterm = false): Promise<void> {
  await writeFile(
    join(tmpDir, "package.json"),
    JSON.stringify({
      scripts: {
        // `&&` deliberately makes detectDevCommand wrap this in `sh -c`,
        // matching scripts that use concurrently or chained commands.
        dev: 'node verify-parent.mjs && node -e "process.exit(0)"',
      },
    })
  );
  const sigtermHandler = ignoreSigterm
    ? 'process.on("SIGTERM", () => {});'
    : "";
  await writeFile(
    join(tmpDir, "verify-parent.mjs"),
    `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";

      ${sigtermHandler}
      const child = spawn(
        process.execPath,
        [
          "-e",
          ${JSON.stringify(`${sigtermHandler} setInterval(() => {}, 1000);`)},
        ],
        { stdio: "inherit" }
      );
      writeFileSync(
        "processes.json",
        JSON.stringify({
          shellPid: process.ppid,
          parentPid: process.pid,
          childPid: child.pid,
        })
      );
      process.stderr.write("SyntaxError: verification fixture\\n");
      setInterval(() => {}, 1000);
    `
  );
}

/** Poll for the fixture's PID file while verification is still running. */
async function readFixtureProcesses(): Promise<FixtureProcesses> {
  const path = join(tmpDir, "processes.json");
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as FixtureProcesses;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await wait(25);
    }
  }
}

describe("verifySetup", () => {
  test("records a skipped verify as a scope tag, not an error, when there is no dev command", async () => {
    const { ui, calls } = createMockUI();

    const result = await verifySetup(
      { status: "success", result: { platform: "cocoa" } },
      ui,
      tmpDir
    );

    expect(result).toEqual({ verified: false, kind: "skipped" });
    expect(calls).toContainEqual({
      kind: "log.info",
      message: "Skipping verification — could not detect a dev command",
    });
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
    expect(sentryMocks.setTag).toHaveBeenCalledWith("wizard.verify", "skipped");
    expect(sentryMocks.addBreadcrumb).toHaveBeenCalledWith({
      category: "wizard.verify",
      level: "info",
      message: "skipped:no_dev_command",
    });
  });

  test("does not fail init when the detected command cannot be spawned", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "missing-sentry-test-command" } })
    );
    const { ui, calls } = createMockUI();

    const result = await verifySetup(
      { status: "success", result: { platform: "javascript-nextjs" } },
      ui,
      tmpDir
    );
    // The SDK never phoned home, so nothing to verify or deep-link.
    expect(result.verified).toBe(false);
    expect(result.eventId).toBeUndefined();

    expect(calls).toContainEqual({
      kind: "log.warn",
      message: "Skipping verification — could not start the dev command.",
    });
    expect(sentryMocks.captureException).not.toHaveBeenCalled();
    expect(sentryMocks.setTag).toHaveBeenCalledWith("wizard.verify", "skipped");
    expect(sentryMocks.addBreadcrumb).toHaveBeenCalledWith({
      category: "wizard.verify",
      level: "info",
      message: "skipped:spawn_failed",
    });
  });

  test.skipIf(process.platform === "win32")(
    "terminates shell descendants that inherit the verification pipes",
    async () => {
      await writeProcessTreeFixture();

      const { ui, calls } = createMockUI();
      const verification = verifySetup(
        { status: "success", result: { platform: "javascript-nextjs" } },
        ui,
        tmpDir
      );
      fixtureProcesses = await readFixtureProcesses();
      await verification;

      expect(await waitForProcessExit(fixtureProcesses.shellPid)).toBe(true);
      expect(await waitForProcessExit(fixtureProcesses.parentPid)).toBe(true);
      expect(await waitForProcessExit(fixtureProcesses.childPid)).toBe(true);
      fixtureProcesses = undefined;
      expect(calls).toContainEqual({
        kind: "log.warn",
        message:
          "Could not verify — startup error: SyntaxError: verification fixture",
      });
    }
  );

  test.skipIf(process.platform === "win32")(
    "force-kills descendants that ignore SIGTERM",
    async () => {
      await writeProcessTreeFixture(true);

      const { ui } = createMockUI();
      const verification = verifySetup(
        { status: "success", result: { platform: "javascript-nextjs" } },
        ui,
        tmpDir
      );
      fixtureProcesses = await readFixtureProcesses();
      await verification;

      expect(await waitForProcessExit(fixtureProcesses.shellPid)).toBe(true);
      expect(await waitForProcessExit(fixtureProcesses.parentPid)).toBe(true);
      expect(await waitForProcessExit(fixtureProcesses.childPid)).toBe(true);
      fixtureProcesses = undefined;
    },
    10_000
  );
});
