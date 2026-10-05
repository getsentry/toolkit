/**
 * Tests for `sentry dart-symbol-map upload` command.
 *
 * Tests validation of dart symbol map files, debug ID format,
 * --no-upload dry-run mode, and error handling.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { app } from "../../../src/app.js";
import type { SentryContext } from "../../../src/context.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("dart-symbol-map-");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "dart-symbol-map-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Run the dart-symbol-map upload command and capture stdout/stderr.
 */
async function runUpload(
  args: string[]
): Promise<{ output: string; exitCode: number | undefined; error?: string }> {
  let output = "";
  let error = "";
  const mockContext: SentryContext = {
    process: {
      ...process,
      exitCode: undefined,
    } as typeof process,
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
    stderr: {
      write(data: string | Uint8Array) {
        error +=
          typeof data === "string" ? data : new TextDecoder().decode(data);
        return true;
      },
    },
    stdin: process.stdin,
  };

  await run(app, ["dart-symbol-map", "upload", ...args], mockContext);
  return { output, exitCode: mockContext.process.exitCode, error };
}

const VALID_DEBUG_ID = "12345678-1234-1234-1234-123456789abc";

describe("sentry dart-symbol-map upload", () => {
  test("--no-upload validates and prints result without uploading", async () => {
    const mapPath = join(tempDir, "map.json");
    await writeFile(
      mapPath,
      JSON.stringify(["obfuscated1", "original1", "obfuscated2", "original2"])
    );

    const { output } = await runUpload([
      "--debug-id",
      VALID_DEBUG_ID,
      "--no-upload",
      mapPath,
    ]);
    expect(output).toContain(VALID_DEBUG_ID);
    expect(output).toContain(mapPath);
  });

  test("--no-upload --json outputs structured data", async () => {
    const mapPath = join(tempDir, "map.json");
    await writeFile(mapPath, JSON.stringify(["obfuscated", "original"]));

    const { output } = await runUpload([
      "--debug-id",
      VALID_DEBUG_ID,
      "--no-upload",
      "--json",
      mapPath,
    ]);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("debugId", VALID_DEBUG_ID);
    expect(parsed).toHaveProperty("path", mapPath);
    expect(parsed).toHaveProperty("uploaded", false);
  });

  test("rejects invalid debug ID format", async () => {
    const mapPath = join(tempDir, "map.json");
    await writeFile(mapPath, JSON.stringify(["a", "b"]));

    const { exitCode } = await runUpload([
      "--debug-id",
      "not-a-uuid",
      "--no-upload",
      mapPath,
    ]);
    expect(exitCode).not.toBe(0);
  });

  test("rejects non-JSON file", async () => {
    const mapPath = join(tempDir, "map.json");
    await writeFile(mapPath, "this is not json");

    const { exitCode } = await runUpload([
      "--debug-id",
      VALID_DEBUG_ID,
      "--no-upload",
      mapPath,
    ]);
    expect(exitCode).not.toBe(0);
  });

  test("rejects non-array JSON", async () => {
    const mapPath = join(tempDir, "map.json");
    await writeFile(mapPath, JSON.stringify({ key: "value" }));

    const { exitCode } = await runUpload([
      "--debug-id",
      VALID_DEBUG_ID,
      "--no-upload",
      mapPath,
    ]);
    expect(exitCode).not.toBe(0);
  });

  test("rejects array with non-string entries", async () => {
    const mapPath = join(tempDir, "map.json");
    await writeFile(mapPath, JSON.stringify(["valid", 42]));

    const { exitCode } = await runUpload([
      "--debug-id",
      VALID_DEBUG_ID,
      "--no-upload",
      mapPath,
    ]);
    expect(exitCode).not.toBe(0);
  });

  test("rejects array with odd number of entries", async () => {
    const mapPath = join(tempDir, "map.json");
    await writeFile(
      mapPath,
      JSON.stringify(["obfuscated1", "original1", "orphan"])
    );

    const { exitCode } = await runUpload([
      "--debug-id",
      VALID_DEBUG_ID,
      "--no-upload",
      mapPath,
    ]);
    expect(exitCode).not.toBe(0);
  });

  test("rejects empty file", async () => {
    const mapPath = join(tempDir, "map.json");
    await writeFile(mapPath, "");

    const { exitCode } = await runUpload([
      "--debug-id",
      VALID_DEBUG_ID,
      "--no-upload",
      mapPath,
    ]);
    expect(exitCode).not.toBe(0);
  });

  test("rejects nonexistent file", async () => {
    const { exitCode } = await runUpload([
      "--debug-id",
      VALID_DEBUG_ID,
      "--no-upload",
      join(tempDir, "nonexistent.json"),
    ]);
    expect(exitCode).not.toBe(0);
  });

  test("accepts valid map with empty array", async () => {
    const mapPath = join(tempDir, "map.json");
    await writeFile(mapPath, JSON.stringify([]));

    const { output } = await runUpload([
      "--debug-id",
      VALID_DEBUG_ID,
      "--no-upload",
      mapPath,
    ]);
    expect(output).toContain(VALID_DEBUG_ID);
  });

  test("accepts -d as alias for --debug-id", async () => {
    const mapPath = join(tempDir, "map.json");
    await writeFile(mapPath, JSON.stringify(["a", "b"]));

    const { output } = await runUpload([
      "-d",
      VALID_DEBUG_ID,
      "--no-upload",
      mapPath,
    ]);
    expect(output).toContain(VALID_DEBUG_ID);
  });
});
