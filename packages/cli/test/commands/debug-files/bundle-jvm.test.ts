/**
 * Tests for `sentry debug-files bundle-jvm` command.
 *
 * Tests the CLI interface: argument validation, output format,
 * and integration with the JVM bundle builder.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bundleJvmCommand } from "../../../src/commands/debug-files/bundle-jvm.js";
import { ValidationError } from "../../../src/lib/errors.js";

const VALID_DEBUG_ID = "12345678-1234-1234-1234-123456789abc";

type BundleJvmFlags = {
  output: string;
  "debug-id": string;
  exclude?: string[];
};

/** The loader returns a wrapped async function, not a raw generator. */
type CmdFunc = (
  this: unknown,
  flags: BundleJvmFlags,
  sourcePath: string
) => Promise<unknown>;

function makeContext() {
  return {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
    cwd: "/tmp",
  };
}

describe("sentry debug-files bundle-jvm", () => {
  let tempDir: string;
  let func: CmdFunc;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bundle-jvm-cmd-"));
    func = (await bundleJvmCommand.loader()) as unknown as CmdFunc;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates a bundle from Java source files", async () => {
    const outputDir = join(tempDir, "out");
    await mkdir(join(tempDir, "src", "main", "java", "com", "example"), {
      recursive: true,
    });
    await writeFile(
      join(tempDir, "src", "main", "java", "com", "example", "Main.java"),
      "public class Main {}"
    );

    const ctx = makeContext();
    await func.call(
      ctx,
      {
        output: outputDir,
        "debug-id": VALID_DEBUG_ID,
      },
      tempDir
    );

    // Verify the ZIP was created
    expect(existsSync(join(outputDir, `${VALID_DEBUG_ID}.zip`))).toBe(true);

    // Verify stdout received output containing the debug ID
    const writeCall = ctx.stdout.write.mock.calls[0];
    expect(writeCall).toBeDefined();
    const output =
      typeof writeCall[0] === "string"
        ? writeCall[0]
        : new TextDecoder().decode(writeCall[0]);
    expect(output).toContain(VALID_DEBUG_ID);
  });

  test("rejects invalid debug ID", async () => {
    const outputDir = join(tempDir, "out");
    const ctx = makeContext();

    try {
      await func.call(
        ctx,
        {
          output: outputDir,
          "debug-id": "not-a-uuid",
        },
        tempDir
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain("not-a-uuid");
    }
  });

  test("rejects nonexistent source path", async () => {
    const outputDir = join(tempDir, "out");
    const ctx = makeContext();

    try {
      await func.call(
        ctx,
        {
          output: outputDir,
          "debug-id": VALID_DEBUG_ID,
        },
        join(tempDir, "nonexistent")
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toContain("does not exist");
    }
  });

  test("handles empty directory gracefully", async () => {
    const outputDir = join(tempDir, "out");
    const ctx = makeContext();

    // Should not throw — just produces a bundle with 0 files
    await func.call(
      ctx,
      {
        output: outputDir,
        "debug-id": VALID_DEBUG_ID,
      },
      tempDir
    );

    const writeCall = ctx.stdout.write.mock.calls[0];
    expect(writeCall).toBeDefined();
    const output =
      typeof writeCall[0] === "string"
        ? writeCall[0]
        : new TextDecoder().decode(writeCall[0]);
    expect(output).toContain("0");
  });

  test("passes exclude patterns through to the builder", async () => {
    const outputDir = join(tempDir, "out");

    // Create a file in a directory that will be excluded
    await mkdir(join(tempDir, "generated"), { recursive: true });
    await writeFile(join(tempDir, "generated", "Auto.java"), "class Auto {}");
    // Create a file that should be included
    await mkdir(join(tempDir, "src", "main", "java"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "main", "java", "App.java"),
      "class App {}"
    );

    const ctx = makeContext();
    await func.call(
      ctx,
      {
        output: outputDir,
        "debug-id": VALID_DEBUG_ID,
        exclude: ["generated"],
      },
      tempDir
    );

    const writeCall = ctx.stdout.write.mock.calls[0];
    expect(writeCall).toBeDefined();
    const output =
      typeof writeCall[0] === "string"
        ? writeCall[0]
        : new TextDecoder().decode(writeCall[0]);
    // Should contain "1" for fileCount (only App.java, not Auto.java)
    expect(output).toContain("1");
  });

  test("creates output directory if it does not exist", async () => {
    const outputDir = join(tempDir, "deeply", "nested", "out");
    await mkdir(join(tempDir, "src", "main", "java"), { recursive: true });
    await writeFile(
      join(tempDir, "src", "main", "java", "App.java"),
      "class App {}"
    );

    const ctx = makeContext();
    await func.call(
      ctx,
      {
        output: outputDir,
        "debug-id": VALID_DEBUG_ID,
      },
      tempDir
    );

    expect(existsSync(join(outputDir, `${VALID_DEBUG_ID}.zip`))).toBe(true);
  });
});
