/**
 * Bundle Smoke Tests
 *
 * Verifies the npm bundle is correctly built and can be executed by Node.js.
 * These tests ensure the bundle has proper shebang and runs without syntax errors.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, test } from "vitest";
import { BUNDLE_BIN_PATH, ensureBundleBuilt } from "./bundle-setup.js";

function noop(): void {
  // Intentionally empty — absorbs async spawn errors
}

/** Spawn a process, collect stdout/stderr as strings, and return exit code. */
async function spawnCollect(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn(cmd, args, {
    cwd: opts?.cwd,
    env: opts?.env,
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
  return { stdout, stderr, exitCode };
}

const ROOT_DIR = join(import.meta.dirname, "../..");
const INK_APP_PATH = join(ROOT_DIR, "dist/ink-app.js");

describe("npm bundle", () => {
  beforeAll(async () => {
    await ensureBundleBuilt();
  }, 60_000); // Bundle can take a while

  test("bundle file exists", () => {
    expect(existsSync(BUNDLE_BIN_PATH)).toBe(true);
  });

  test("bundle starts with node shebang", async () => {
    const content = await readFile(BUNDLE_BIN_PATH, "utf-8");

    // The bundle MUST start with the Node.js shebang for npm global installs to work
    // Without this, Unix shells try to execute the JavaScript as shell commands
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  test("bundle executes without syntax errors", async () => {
    // Run the bundle with --version to verify it executes correctly
    // Using --version instead of --help as it has fewer dependencies
    // This catches the exact error from the bug report where the shell
    // tried to interpret JavaScript as shell commands
    const { stdout, stderr } = await spawnCollect(
      "node",
      [BUNDLE_BIN_PATH, "--version"],
      {
        cwd: ROOT_DIR,
      }
    );

    // Should not have shell syntax errors (the original bug)
    expect(stderr).not.toContain("syntax error");
    expect(stderr).not.toContain("unexpected token");

    // The CLI should start and produce some output
    // Even if it exits non-zero due to missing config, it should run as JS not shell
    const output = stdout + stderr;
    expect(output.length).toBeGreaterThan(0);
  }, 15_000); // Allow up to 15s for cold Node.js JIT startup on slow CI runners

  test("bundle does not emit Node.js warnings", async () => {
    // Run the bundle and capture stderr to check for warnings
    // This ensures we don't regress on warning suppression (e.g., SQLite experimental)
    const { stderr } = await spawnCollect(
      "node",
      [BUNDLE_BIN_PATH, "--version"],
      {
        cwd: ROOT_DIR,
      }
    );

    // Should not have any Node.js warnings
    expect(stderr).not.toContain("ExperimentalWarning");
    expect(stderr).not.toContain("DeprecationWarning");
    expect(stderr).not.toContain("Warning:");
  }, 15_000); // Allow up to 15s for cold Node.js JIT startup on slow CI runners

  test("bundle can be executed directly on Unix", async () => {
    // Skip on Windows where shebang doesn't apply
    if (process.platform === "win32") {
      return;
    }

    // Make the bundle executable
    const { chmod } = await import("node:fs/promises");
    await chmod(BUNDLE_BIN_PATH, 0o755);

    // Execute it directly (like npm global install would)
    const { stdout, stderr } = await spawnCollect(
      BUNDLE_BIN_PATH,
      ["--version"],
      {
        cwd: ROOT_DIR,
      }
    );

    // This is the exact error from the bug report - shell interpreting JS as bash
    expect(stderr).not.toContain("syntax error near unexpected token");

    // The CLI should start and produce some output
    const output = stdout + stderr;
    expect(output.length).toBeGreaterThan(0);
  }, 15_000); // Allow up to 15s for cold Node.js JIT startup on slow CI runners

  test("bundle exercises SQLite and auth DB (auth status)", async () => {
    // Run `auth status` without a token — exercises SQLite initialization,
    // schema migrations, auth DB reads, and telemetry lazy import.
    // This catches lazy-import and require-resolution bugs that --version misses.
    const { stdout, stderr, exitCode } = await spawnCollect(
      "node",
      [BUNDLE_BIN_PATH, "auth", "status"],
      {
        cwd: ROOT_DIR,
        env: {
          ...process.env,
          // Do NOT set SENTRY_CLI_NO_TELEMETRY — we want to exercise telemetry init
          SENTRY_AUTH_TOKEN: "",
          SENTRY_TOKEN: "",
        },
      }
    );

    const output = stdout + stderr;

    // Must exit 10 (AUTH_NOT_AUTHENTICATED), not crash
    expect(exitCode).toBe(10);
    expect(output.toLowerCase()).toContain("not authenticated");

    // Must not contain Node.js module resolution errors
    expect(output).not.toContain("Cannot find module");
    expect(output).not.toContain("MODULE_NOT_FOUND");
    expect(output).not.toContain("ERR_MODULE_NOT_FOUND");
  }, 15_000);

  test("bundle exercises SQLite with cli defaults", async () => {
    // `cli defaults` (no args) reads all defaults from SQLite — exercises
    // DB init and the metadata KV store without requiring auth.
    const { stdout, stderr, exitCode } = await spawnCollect(
      "node",
      [BUNDLE_BIN_PATH, "cli", "defaults"],
      {
        cwd: ROOT_DIR,
        env: {
          ...process.env,
          SENTRY_AUTH_TOKEN: "",
          SENTRY_TOKEN: "",
        },
      }
    );

    const output = stdout + stderr;

    // Should succeed — cli defaults with no args just shows current state
    expect(exitCode).toBe(0);

    // Must not contain module resolution errors
    expect(output).not.toContain("Cannot find module");
    expect(output).not.toContain("MODULE_NOT_FOUND");
  }, 15_000);

  test("Ink sidecar can be imported and exports mountApp", async () => {
    // The Ink sidecar (dist/ink-app.js) is a pre-bundled self-contained ESM
    // module that ships with the npm package. Verify it exists, can be imported
    // by Node, and exports mountApp as a function. This catches sidecar
    // bundling/resolution bugs — the exact class of bug where `with { type: "file" }`
    // crashed in tsx dev mode.
    //
    // Run in a subprocess to avoid polluting the vitest process with
    // React/Ink globals from the sidecar's bundled dependencies.
    expect(existsSync(INK_APP_PATH)).toBe(true);

    const { stdout, stderr, exitCode } = await spawnCollect("node", [
      "--input-type=module",
      "-e",
      `import { mountApp } from ${JSON.stringify(pathToFileURL(INK_APP_PATH).href)};\n` +
        'if (typeof mountApp !== "function") {\n' +
        '  process.stderr.write("mountApp is " + typeof mountApp + ", expected function");\n' +
        "  process.exit(1);\n" +
        "}",
    ]);

    if (exitCode !== 0) {
      const output = stdout + stderr;
      throw new Error(
        `Ink sidecar import failed (exit ${exitCode}): ${output}`
      );
    }
    expect(exitCode).toBe(0);
  }, 15_000);
});
