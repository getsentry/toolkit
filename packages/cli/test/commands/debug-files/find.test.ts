/**
 * Tests for `sentry debug-files find`.
 *
 * Drives the full app router with a deterministic Breakpad symbol fixture (no
 * committed binaries), covering flag wiring, JSON output, the exit code, and
 * the breakpad "reported-but-still-missing" behaviour.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { app } from "../../../src/app.js";
import type { SentryContext } from "../../../src/context.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("debug-files-find-");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "df-find-test-"));
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

const BREAKPAD_ID = "0f13a5da-412a-fbf7-c866-2048f3294f3d";

async function runFind(
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
  await run(app, ["debug-files", "find", ...args], mockContext);
  return { output, exitCode: mockContext.process.exitCode };
}

describe("sentry debug-files find", () => {
  test("finds a breakpad file but still reports the id as missing (exit 1)", async () => {
    await writeFile(join(tempDir, "example.sym"), BREAKPAD_FIXTURE);

    const { output, exitCode } = await runFind([
      BREAKPAD_ID,
      "--no-well-known",
      "--no-cwd",
      "--path",
      tempDir,
      "--json",
    ]);
    const parsed = JSON.parse(output);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0]).toMatchObject({
      type: "breakpad",
      id: BREAKPAD_ID,
    });
    // A breakpad match does not satisfy the request.
    expect(parsed.missing.map((m: { id: string }) => m.id)).toContain(
      BREAKPAD_ID
    );
    expect(exitCode).toBe(1);
  });

  test("exits successfully when there is nothing to find (no ids)", async () => {
    const { exitCode } = await runFind(["--no-cwd", "--no-well-known"]);
    expect(exitCode ?? 0).toBe(0);
  });

  test("rejects an unknown --type", async () => {
    const { exitCode } = await runFind([BREAKPAD_ID, "--type", "bogus"]);
    expect(exitCode).not.toBe(0);
  });

  test("exits 1 with a missing hint when nothing matches", async () => {
    await writeFile(join(tempDir, "example.sym"), BREAKPAD_FIXTURE);
    const { output, exitCode } = await runFind([
      "ffffffff-0000-0000-0000-000000000000",
      "--no-well-known",
      "--no-cwd",
      "-p",
      tempDir,
    ]);
    expect(output).toContain("Missing debug information files");
    expect(exitCode).toBe(1);
  });
});
