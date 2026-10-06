/**
 * Tests for `sentry debug-files check`.
 *
 * Uses Breakpad symbol files (a deterministic text format) as fixtures so the
 * tests need no committed binaries and run identically on every platform.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { app } from "../../../src/app.js";
import type { SentryContext } from "../../../src/context.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("debug-files-check-");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "df-check-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const BREAKPAD_FIXTURE = [
  "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
  "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
  "FUNC 1000 10 0 main",
  "1000 10 42 1",
].join("\n");

const KNOWN_DEBUG_ID = "0f13a5da-412a-fbf7-c866-2048f3294f3d";

/** Run `debug-files check` and capture stdout + exit code. */
async function runCheck(
  args: string[]
): Promise<{ output: string; exitCode: number | undefined }> {
  let output = "";
  const mockContext: SentryContext = {
    process: { ...process, exitCode: undefined } as typeof process,
    env: process.env,
    cwd: process.cwd(),
    homeDir: "/tmp",
    configDir: "/tmp",
    stdout: {
      write(data: string | Uint8Array) {
        output +=
          typeof data === "string" ? data : new TextDecoder().decode(data);
        return true;
      },
    },
    stderr: { write: () => true },
    stdin: process.stdin,
  };

  await run(app, ["debug-files", "check", ...args], mockContext);
  return { output, exitCode: mockContext.process.exitCode };
}

describe("sentry debug-files check", () => {
  test("prints debug id and metadata for a valid file", async () => {
    const path = join(tempDir, "example.sym");
    await writeFile(path, BREAKPAD_FIXTURE);

    const { output } = await runCheck([path]);
    expect(output).toContain(KNOWN_DEBUG_ID);
    expect(output).toContain("x86_64");
    expect(output).toContain("breakpad");
  });

  test("--json outputs structured data", async () => {
    const path = join(tempDir, "example.sym");
    await writeFile(path, BREAKPAD_FIXTURE);

    const { output } = await runCheck([path, "--json"]);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("fileFormat", "breakpad");
    expect(parsed).toHaveProperty("usable", true);
    expect(parsed.objects[0]).toHaveProperty("debugId", KNOWN_DEBUG_ID);
    expect(parsed.objects[0]).toHaveProperty(
      "codeId",
      "daa5130f2a41f7fbc8662048f3294f3d439ca7ff"
    );
  });

  test("rejects a nonexistent file", async () => {
    const { exitCode } = await runCheck([join(tempDir, "missing.sym")]);
    expect(exitCode).not.toBe(0);
  });

  test("rejects a directory", async () => {
    const { exitCode } = await runCheck([tempDir]);
    expect(exitCode).not.toBe(0);
  });

  test("rejects an unrecognized file", async () => {
    const path = join(tempDir, "garbage.bin");
    await writeFile(path, "this is not a debug information file");

    const { exitCode } = await runCheck([path]);
    expect(exitCode).not.toBe(0);
  });

  test("exits non-zero for a parseable but unusable file", async () => {
    // Nil debug id + a symbol: parses fine, but has no usable identifier,
    // so it is not usable for symbolication.
    const path = join(tempDir, "unusable.sym");
    await writeFile(
      path,
      "MODULE Linux x86_64 000000000000000000000000000000000 x\nPUBLIC 1000 0 sym"
    );

    const { output, exitCode } = await runCheck([path, "--json"]);
    expect(JSON.parse(output)).toHaveProperty("usable", false);
    expect(exitCode).toBe(1);
  });
});
