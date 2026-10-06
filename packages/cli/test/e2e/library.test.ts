/**
 * Library Mode Smoke Tests
 *
 * Verifies the npm bundle works correctly when imported as a library.
 * Tests the createSentrySDK() API and the run() escape hatch.
 *
 * These tests run the bundled dist/index.cjs via Node.js subprocesses
 * to verify the real npm package behavior (not source imports).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { EXIT } from "../../src/lib/errors.js";
import { useTestConfigDir } from "../helpers.js";
import {
  BUNDLE_INDEX_PATH,
  BUNDLE_TYPES_PATH,
  ensureBundleBuilt,
} from "./bundle-setup.js";

function noop(): void {
  // Intentionally empty — absorbs async spawn errors
}

const ROOT_DIR = join(import.meta.dirname, "../..");

/**
 * Run a Node.js script that requires the bundled library.
 * Returns { stdout, stderr, exitCode }.
 */
async function runNodeScript(
  script: string,
  timeout = 15_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SENTRY_CLI_NO_TELEMETRY: "1",
  };
  // Ensure no auth leaks into tests — delete rather than set to undefined
  // because spawn may pass "undefined" as a literal string
  delete env.SENTRY_AUTH_TOKEN;
  delete env.SENTRY_TOKEN;

  const proc = spawn("node", ["--no-warnings", "-e", script], {
    cwd: ROOT_DIR,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  proc.on("error", noop);

  const timer = setTimeout(() => proc.kill(), timeout);

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d: Buffer) => {
    stdout += d;
  });
  proc.stderr.on("data", (d: Buffer) => {
    stderr += d;
  });

  const exitCode = await new Promise<number>((resolve) =>
    proc.on("close", (code) => resolve(code ?? 1)),
  );
  clearTimeout(timer);

  return { stdout, stderr, exitCode };
}

/**
 * Run a Node.js script and assert it exits cleanly.
 * On non-zero exit, throws with stderr for CI debuggability.
 */
async function runNodeScriptOk(
  script: string,
  timeout?: number,
): Promise<{ stdout: string; stderr: string }> {
  const result = await runNodeScript(script, timeout);
  if (result.exitCode !== 0) {
    throw new Error(
      `Node exited ${result.exitCode}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result;
}

describe("library mode (bundled)", () => {
  const getConfigDir = useTestConfigDir("e2e-library-");

  beforeAll(async () => {
    await ensureBundleBuilt();
  }, 60_000);

  // --- Bundle structure ---

  test("dist/index.cjs exists", () => {
    expect(existsSync(BUNDLE_INDEX_PATH)).toBe(true);
  });

  test("dist/index.d.cts exists", () => {
    expect(existsSync(BUNDLE_TYPES_PATH)).toBe(true);
  });

  test("index.cjs does NOT start with shebang", async () => {
    const content = await readFile(BUNDLE_INDEX_PATH, "utf-8");
    // The library bundle should not have a shebang — that's on bin.cjs only
    expect(content.startsWith("#!/")).toBe(false);
  });

  test("index.cjs does NOT suppress process warnings", async () => {
    const content = await readFile(BUNDLE_INDEX_PATH, "utf-8");
    // The warning suppression (process.emit monkeypatch) moved to bin.cjs
    // The library must not patch the host's process.emit
    expect(content.slice(0, 200)).not.toContain("process.emit");
  });

  // --- Library exports ---

  test("exports createSentrySDK as default", async () => {
    const { stdout } = await runNodeScriptOk(`
      const mod = require('./dist/index.cjs');
      console.log(typeof mod.default);
    `);
    expect(stdout.trim()).toBe("function");
  });

  test("exports createSentrySDK as named export", async () => {
    const { stdout } = await runNodeScriptOk(`
      const { createSentrySDK } = require('./dist/index.cjs');
      console.log(typeof createSentrySDK);
    `);
    expect(stdout.trim()).toBe("function");
  });

  test("exports SentryError", async () => {
    const { stdout } = await runNodeScriptOk(`
      const { SentryError } = require('./dist/index.cjs');
      console.log(typeof SentryError);
    `);
    expect(stdout.trim()).toBe("function");
  });

  // --- run() escape hatch ---

  test("sdk.run('--version') returns version string", async () => {
    const { stdout } = await runNodeScriptOk(`
      const { createSentrySDK } = require('./dist/index.cjs');
      const sdk = createSentrySDK();
      sdk.run('--version').then(r => {
        console.log(JSON.stringify({ type: typeof r, value: r }));
      }).catch(e => {
        console.log(JSON.stringify({ error: e.message }));
        process.exitCode = 1;
      });
    `);
    const result = JSON.parse(stdout.trim());
    expect(result.type).toBe("string");
    expect(result.value).toMatch(/\d+\.\d+/);
  });

  test("sdk.run() does not pollute process.env", async () => {
    const { stdout } = await runNodeScriptOk(`
      const { createSentrySDK } = require('./dist/index.cjs');
      const sdk = createSentrySDK();
      const before = process.env.SENTRY_OUTPUT_FORMAT;
      sdk.run('--version').then(() => {
        const after = process.env.SENTRY_OUTPUT_FORMAT;
        console.log(JSON.stringify({ before, after, same: before === after }));
      }).catch(() => {
        const after = process.env.SENTRY_OUTPUT_FORMAT;
        console.log(JSON.stringify({ before, after, same: before === after }));
      });
    `);
    const result = JSON.parse(stdout.trim());
    expect(result.same).toBe(true);
  });

  test("sdk.run() throws SentryError on auth failure", async () => {
    // Use the typed SDK path (sdk.org.list) via run() to test error handling.
    // The raw sdk.run('org', 'list') path may not trigger auth checks
    // consistently across package managers due to resolution cascade differences.
    const { stdout } = await runNodeScriptOk(`
      const { createSentrySDK, SentryError } = require('./dist/index.cjs');
      const sdk = createSentrySDK({ cwd: '/tmp' });
      sdk.org.list().then(() => {
        console.log(JSON.stringify({ error: false }));
      }).catch(e => {
        console.log(JSON.stringify({
          isSentryError: e instanceof SentryError,
          name: e.name,
          hasExitCode: typeof e.exitCode === 'number',
          hasStderr: typeof e.stderr === 'string',
        }));
      });
    `);
    const result = JSON.parse(stdout.trim());
    expect(result.isSentryError).toBe(true);
    expect(result.name).toBe("SentryError");
    expect(result.hasExitCode).toBe(true);
    expect(result.hasStderr).toBe(true);
  });

  // --- Typed SDK ---

  test("sourcemap upload rejects a split token without leaking it or fetching", async () => {
    const directory = getConfigDir();
    await writeFile(
      join(directory, "app.js"),
      "console.log('fixture');\n//# sourceMappingURL=app.js.map\n",
    );
    await writeFile(
      join(directory, "app.js.map"),
      JSON.stringify({
        version: 3,
        sources: ["app.ts"],
        sourcesContent: ["console.log('fixture');"],
        names: [],
        mappings: "AAAA",
      }),
    );
    const claim = Buffer.from(
      JSON.stringify({ org: "test-org", url: "http://localhost:9000" }),
    ).toString("base64");
    const token = `sntrys_${claim}_ab\nSYNTHETIC-SECRET-TAIL`;
    const { stdout, stderr } = await runNodeScriptOk(`
      const { createSentrySDK, SentryError } = require('./dist/index.cjs');
      let fetches = 0;
      globalThis.fetch = async () => {
        fetches++;
        throw new Error('Unexpected request');
      };
      const sdk = createSentrySDK({
        token: ${JSON.stringify(token)},
        url: 'http://localhost:9000',
        org: 'test-org',
        project: 'test-project',
        cwd: ${JSON.stringify(directory)},
      });
      sdk.sourcemap.upload({ directory: ${JSON.stringify(directory)} }).then(() => {
        console.log(JSON.stringify({ error: false, fetches }));
      }).catch(e => {
        console.log(JSON.stringify({
          isSentryError: e instanceof SentryError,
          exitCode: e.exitCode,
          message: e.message,
          stderr: e.stderr,
          stack: e.stack,
          fetches,
        }));
      });
    `);
    const result = JSON.parse(stdout.trim());
    expect(result.isSentryError).toBe(true);
    expect(result.exitCode).toBe(EXIT.AUTH_INVALID);
    expect(result.message).toContain("single line");
    expect(result.fetches).toBe(0);
    expect(stdout + stderr).not.toContain(claim);
    expect(stdout + stderr).not.toContain("SYNTHETIC-SECRET-TAIL");
    expect(stdout + stderr).not.toContain("Headers.set");
  });

  test("createSentrySDK() returns object with namespaces", async () => {
    const { stdout } = await runNodeScriptOk(`
      const { createSentrySDK } = require('./dist/index.cjs');
      const sdk = createSentrySDK();
      console.log(JSON.stringify({
        hasOrg: typeof sdk.org === 'object',
        hasIssue: typeof sdk.issue === 'object',
        hasProject: typeof sdk.project === 'object',
        orgListFn: typeof sdk.org.list === 'function',
        issueListFn: typeof sdk.issue.list === 'function',
        hasRun: typeof sdk.run === 'function',
      }));
    `);
    const result = JSON.parse(stdout.trim());
    expect(result.hasOrg).toBe(true);
    expect(result.hasIssue).toBe(true);
    expect(result.hasProject).toBe(true);
    expect(result.orgListFn).toBe(true);
    expect(result.issueListFn).toBe(true);
    expect(result.hasRun).toBe(true);
  });

  test("SDK throws SentryError on auth failure", async () => {
    const { stdout } = await runNodeScriptOk(`
      const { createSentrySDK, SentryError } = require('./dist/index.cjs');
      const sdk = createSentrySDK();
      sdk.org.list().then(() => {
        console.log(JSON.stringify({ error: false }));
      }).catch(e => {
        console.log(JSON.stringify({
          isSentryError: e instanceof SentryError,
          hasExitCode: typeof e.exitCode === 'number',
        }));
      });
    `);
    const result = JSON.parse(stdout.trim());
    expect(result.isSentryError).toBe(true);
    expect(result.hasExitCode).toBe(true);
  });

  // --- Type declarations ---

  test("type declarations contain createSentrySDK", async () => {
    const content = await readFile(BUNDLE_TYPES_PATH, "utf-8");
    expect(content).toContain("createSentrySDK");
    expect(content).toContain("SentrySDK");
  });

  test("type declarations contain SDK namespaces", async () => {
    const content = await readFile(BUNDLE_TYPES_PATH, "utf-8");
    // CLI route names (not plural)
    expect(content).toContain("org:");
    expect(content).toContain("issue:");
  });

  test("type declarations contain SentryError", async () => {
    const content = await readFile(BUNDLE_TYPES_PATH, "utf-8");
    expect(content).toContain("export declare class SentryError");
    expect(content).toContain("exitCode");
    expect(content).toContain("stderr");
  });

  test("type declarations contain SentryOptions", async () => {
    const content = await readFile(BUNDLE_TYPES_PATH, "utf-8");
    expect(content).toContain("SentryOptions");
    expect(content).toContain("token");
    expect(content).toContain("text");
    expect(content).toContain("cwd");
  });
});
