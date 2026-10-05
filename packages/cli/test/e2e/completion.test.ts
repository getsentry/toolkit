/**
 * Completion Latency E2E Tests
 *
 * Spawns the actual CLI binary with `__complete` args and measures
 * wall-clock latency. The completion fast-path skips @sentry/node-core,
 * Stricli, and middleware — these tests catch regressions that would
 * re-introduce heavy imports into the completion path.
 *
 * Pre-optimization baseline: ~530ms (dev), ~320ms (binary)
 * Post-optimization target:  ~60ms  (dev), ~190ms (binary)
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { getCliCommand } from "../fixture.js";

function noop(): void {
  // Intentionally empty — absorbs async spawn errors
}

const cliDir = join(import.meta.dirname, "../..");

/** Spawn a CLI process and measure wall-clock duration. */
async function measureCommand(
  args: string[],
  env?: Record<string, string | undefined>
): Promise<{
  duration: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const [cmdBin, ...cmdArgs] = getCliCommand();
  const start = performance.now();
  const proc = spawn(cmdBin, [...cmdArgs, ...args], {
    cwd: cliDir,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.on("error", noop);

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d: Buffer) => {
    stdout += d;
  });
  proc.stderr.on("data", (d: Buffer) => {
    stderr += d;
  });

  const exitCode = await new Promise<number>((resolve) =>
    proc.on("close", (code) => resolve(code ?? 1))
  );

  return {
    duration: performance.now() - start,
    exitCode,
    stdout,
    stderr,
  };
}

describe("completion latency", () => {
  test("completion exits under 500ms", async () => {
    const result = await measureCommand(["__complete", "issue", "list", ""]);

    expect(result.exitCode).toBe(0);

    // 500ms budget: dev mode ~67ms, CI ~140ms, slow CI runners ~300ms,
    // pre-optimization ~530ms. Generous enough for CI jitter while still
    // catching real regressions (pre-optimization was 530ms+).
    expect(result.duration).toBeLessThan(500);
  });

  test("completion exits cleanly with no stderr", async () => {
    const result = await measureCommand(["__complete", "org", "view", ""]);

    expect(result.exitCode).toBe(0);
    // No error output — completions should be silent on stderr
    expect(result.stderr).toBe("");
  });

  test("completion with empty args exits cleanly", async () => {
    const result = await measureCommand(["__complete", ""]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  });
});
