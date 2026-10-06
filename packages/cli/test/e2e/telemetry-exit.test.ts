/**
 * Telemetry Exit Timing E2E Tests
 *
 * Tests that the CLI exits quickly even when telemetry is enabled.
 * This verifies the @sentry/core patch that adds .unref() to flush timers.
 *
 * Without the patch, flush(3000) blocks for ~3 seconds due to non-unref'd timers.
 * With the patch, the process can exit immediately when there's nothing to send.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { getCliCommand } from "../fixture.js";

function noop(): void {
  // Intentionally empty — absorbs async spawn errors
}

const cliDir = join(import.meta.dirname, "../..");

describe("telemetry exit timing", () => {
  test("process exits without waiting for flush timeout", async () => {
    const cmd = getCliCommand();

    // Baseline: telemetry disabled
    const disabledStart = performance.now();
    const [cmdBin, ...cmdArgs] = cmd;
    const disabledProc = spawn(cmdBin, [...cmdArgs, "--version"], {
      cwd: cliDir,
      env: { ...process.env, SENTRY_CLI_NO_TELEMETRY: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    disabledProc.on("error", noop);
    const disabledExitCode = await new Promise<number>((resolve) =>
      disabledProc.on("close", (code) => resolve(code ?? 1))
    );
    const disabledDuration = performance.now() - disabledStart;

    // Test: telemetry enabled (with patched Sentry)
    // Remove SENTRY_CLI_NO_TELEMETRY to enable telemetry
    const envWithTelemetry = { ...process.env };
    delete envWithTelemetry.SENTRY_CLI_NO_TELEMETRY;

    const enabledStart = performance.now();
    const enabledProc = spawn(cmdBin, [...cmdArgs, "--version"], {
      cwd: cliDir,
      env: envWithTelemetry,
      stdio: ["pipe", "pipe", "pipe"],
    });
    enabledProc.on("error", noop);
    const enabledExitCode = await new Promise<number>((resolve) =>
      enabledProc.on("close", (code) => resolve(code ?? 1))
    );
    const enabledDuration = performance.now() - enabledStart;

    // Both should complete successfully
    expect(disabledExitCode).toBe(0);
    expect(enabledExitCode).toBe(0);

    // Enabled should not be significantly slower than disabled.
    // Allow 1000ms overhead for Sentry init + potential network attempt +
    // CI scheduling jitter, but NOT the old 3000ms+ timeout behavior.
    expect(enabledDuration).toBeLessThan(disabledDuration * 1.5 + 1000);

    // And definitely under 2 seconds total (old behavior was 3+ seconds)
    expect(enabledDuration).toBeLessThan(2000);
  });
});
