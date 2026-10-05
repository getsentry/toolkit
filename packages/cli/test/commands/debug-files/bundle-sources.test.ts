/**
 * Tests for `sentry debug-files bundle-sources`.
 *
 * Uses Breakpad symbol files (a deterministic text format) as fixtures. The
 * `FILE` record points at a real file inside the test's temp dir so the
 * command's on-disk source read actually succeeds — no committed binaries and
 * identical behavior on every platform.
 */

import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { app } from "../../../src/app.js";
import type { SentryContext } from "../../../src/context.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("debug-files-bundle-sources-");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "df-bundle-sources-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Build a Breakpad symbol file that references a single source file.
 *
 * @param sourcePath - Absolute path recorded in the `FILE` record.
 */
function breakpadReferencing(sourcePath: string): string {
  return [
    "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
    "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
    `FILE 0 ${sourcePath}`,
    "FUNC 1000 10 0 main",
    "1000 10 42 0",
  ].join("\n");
}

const KNOWN_DEBUG_ID = "0f13a5da-412a-fbf7-c866-2048f3294f3d";

/** Run `debug-files bundle-sources` and capture stdout + exit code. */
async function runBundleSources(
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

  await run(app, ["debug-files", "bundle-sources", ...args], mockContext);
  return { output, exitCode: mockContext.process.exitCode };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("sentry debug-files bundle-sources", () => {
  test("bundles a referenced source file that exists on disk", async () => {
    const sourcePath = join(tempDir, "example.c");
    await writeFile(sourcePath, "int main(void) { return 0; }\n");
    const debugPath = join(tempDir, "example.sym");
    await writeFile(debugPath, breakpadReferencing(sourcePath));

    const { output, exitCode } = await runBundleSources([debugPath]);

    expect(exitCode).toBe(0);
    expect(output).toContain(KNOWN_DEBUG_ID);
    expect(output).toContain("Files bundled");
    expect(await exists(`${debugPath}.src.zip`)).toBe(true);
  });

  test("writes to a custom --output path", async () => {
    const sourcePath = join(tempDir, "example.c");
    await writeFile(sourcePath, "int main(void) { return 0; }\n");
    const debugPath = join(tempDir, "example.sym");
    await writeFile(debugPath, breakpadReferencing(sourcePath));
    const outPath = join(tempDir, "custom.src.zip");

    const { exitCode } = await runBundleSources([debugPath, "-o", outPath]);

    expect(exitCode).toBe(0);
    expect(await exists(outPath)).toBe(true);
    expect(await exists(`${debugPath}.src.zip`)).toBe(false);
  });

  test("creates the output directory if it does not exist", async () => {
    const sourcePath = join(tempDir, "example.c");
    await writeFile(sourcePath, "int main(void) { return 0; }\n");
    const debugPath = join(tempDir, "example.sym");
    await writeFile(debugPath, breakpadReferencing(sourcePath));
    const outPath = join(tempDir, "nested", "dir", "out.src.zip");

    const { exitCode } = await runBundleSources([debugPath, "-o", outPath]);

    expect(exitCode).toBe(0);
    expect(await exists(outPath)).toBe(true);
  });

  test("exits non-zero and writes nothing when no sources are on disk", async () => {
    // FILE record points at a path that does not exist.
    const debugPath = join(tempDir, "example.sym");
    await writeFile(debugPath, breakpadReferencing(join(tempDir, "missing.c")));

    const { output, exitCode } = await runBundleSources([debugPath]);

    expect(exitCode).toBe(1);
    expect(output.toLowerCase()).toContain("no source files");
    expect(await exists(`${debugPath}.src.zip`)).toBe(false);
  });

  test("fails with a validation error for a path that does not exist", async () => {
    // ValidationError -> exit code 21.
    const { exitCode } = await runBundleSources([
      join(tempDir, "does-not-exist.sym"),
    ]);
    expect(exitCode).toBe(21);
  });

  test("fails with a validation error for a non-debug file", async () => {
    const path = join(tempDir, "garbage.bin");
    await writeFile(path, "not an object file");

    const { exitCode } = await runBundleSources([path]);
    expect(exitCode).toBe(21);
  });
});
