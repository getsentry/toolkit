/**
 * Tests for `sentry debug-files print-sources`.
 *
 * Uses Breakpad symbol files (a deterministic text format) whose `FILE` record
 * points at a path under the test's temp dir, so local-availability reporting
 * can be exercised without committed binaries.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { app } from "../../../src/app.js";
import type { SentryContext } from "../../../src/context.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("debug-files-print-sources-");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "df-print-sources-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const KNOWN_DEBUG_ID = "0f13a5da-412a-fbf7-c866-2048f3294f3d";

/** Build a Breakpad symbol file that references a single source file. */
function breakpadReferencing(sourcePath: string): string {
  return [
    "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
    "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
    `FILE 0 ${sourcePath}`,
    "FUNC 1000 10 0 main",
    "1000 10 42 0",
  ].join("\n");
}

/** A Breakpad symbol file that references no source files. */
const BREAKPAD_NO_SOURCES = [
  "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
  "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
  "FUNC 1000 10 0 main",
  "PUBLIC 2000 0 some_symbol",
].join("\n");

/** Run `debug-files print-sources` and capture stdout + exit code. */
async function runPrintSources(
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

  await run(app, ["debug-files", "print-sources", ...args], mockContext);
  return { output, exitCode: mockContext.process.exitCode };
}

describe("sentry debug-files print-sources", () => {
  test("lists a referenced source that exists locally", async () => {
    const sourcePath = join(tempDir, "example.c");
    await writeFile(sourcePath, "int main(void) { return 0; }\n");
    const debugPath = join(tempDir, "example.sym");
    await writeFile(debugPath, breakpadReferencing(sourcePath));

    const { output, exitCode } = await runPrintSources([debugPath]);

    expect(exitCode).toBe(0);
    expect(output).toContain(KNOWN_DEBUG_ID);
    expect(output).toContain(sourcePath);
    expect(output).toContain("available locally");
  });

  test("reports a referenced source that is missing locally", async () => {
    const debugPath = join(tempDir, "example.sym");
    await writeFile(debugPath, breakpadReferencing(join(tempDir, "missing.c")));

    const { output, exitCode } = await runPrintSources([debugPath]);

    expect(exitCode).toBe(0);
    expect(output).toContain("not available locally");
  });

  test("reports when there are no referenced sources", async () => {
    const debugPath = join(tempDir, "example.sym");
    await writeFile(debugPath, BREAKPAD_NO_SOURCES);

    const { output, exitCode } = await runPrintSources([debugPath]);

    expect(exitCode).toBe(0);
    expect(output.toLowerCase()).toContain("no referenced sources");
  });

  test("emits structured JSON with --json", async () => {
    const sourcePath = join(tempDir, "example.c");
    await writeFile(sourcePath, "int main(void) { return 0; }\n");
    const debugPath = join(tempDir, "example.sym");
    await writeFile(debugPath, breakpadReferencing(sourcePath));

    const { output } = await runPrintSources([debugPath, "--json"]);
    const parsed = JSON.parse(output);

    expect(parsed.objects).toHaveLength(1);
    expect(parsed.objects[0].debugId).toBe(KNOWN_DEBUG_ID);
    // Exposed so JSON consumers can apply the same bundled-slice rule as
    // `bundle-sources` and distinguish a failed read from "no sources".
    expect(parsed.objects[0].hasDebugInfo).toBe(true);
    expect(parsed.objects[0].enumerationError).toBeNull();
    expect(parsed.objects[0].files[0].path).toBe(sourcePath);
    expect(parsed.objects[0].files[0].availableLocally).toBe(true);
  });

  test("fails with a validation error for a path that does not exist", async () => {
    const { exitCode } = await runPrintSources([
      join(tempDir, "does-not-exist.sym"),
    ]);
    expect(exitCode).toBe(21);
  });

  test("fails with a validation error for a non-debug file", async () => {
    const path = join(tempDir, "garbage.bin");
    await writeFile(path, "not an object file");

    const { exitCode } = await runPrintSources([path]);
    expect(exitCode).toBe(21);
  });
});
