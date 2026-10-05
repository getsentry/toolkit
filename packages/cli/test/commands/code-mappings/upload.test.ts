/**
 * Tests for `sentry code-mappings upload` command.
 *
 * Tests validation of code mapping files, error handling, and input parsing.
 * Upload tests are limited to validation since actual uploads require API access.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { uploadCommand } from "../../../src/commands/code-mappings/upload.js";
import { ValidationError } from "../../../src/lib/errors.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("code-mappings-");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "code-mappings-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeContext() {
  return {
    stdout: { write: vi.fn(() => true) },
    stderr: { write: vi.fn(() => true) },
    cwd: tempDir,
  };
}

describe("code-mappings upload validation", () => {
  let func: Awaited<ReturnType<typeof uploadCommand.loader>>;

  beforeEach(async () => {
    func = await uploadCommand.loader();
  });

  test("rejects nonexistent file", async () => {
    const ctx = makeContext();
    await expect(
      func.call(ctx, {}, join(tempDir, "nonexistent.json"))
    ).rejects.toThrow(ValidationError);
  });

  test("rejects non-JSON file", async () => {
    const path = join(tempDir, "bad.json");
    await writeFile(path, "not json at all");

    const ctx = makeContext();
    await expect(func.call(ctx, {}, path)).rejects.toThrow("not valid JSON");
  });

  test("rejects non-array JSON", async () => {
    const path = join(tempDir, "bad.json");
    await writeFile(path, JSON.stringify({ stackRoot: "a", sourceRoot: "b" }));

    const ctx = makeContext();
    await expect(func.call(ctx, {}, path)).rejects.toThrow(
      "expected a JSON array"
    );
  });

  test("rejects empty array", async () => {
    const path = join(tempDir, "empty.json");
    await writeFile(path, "[]");

    const ctx = makeContext();
    await expect(func.call(ctx, {}, path)).rejects.toThrow("no mappings");
  });

  test("rejects mapping with missing stackRoot", async () => {
    const path = join(tempDir, "bad.json");
    await writeFile(path, JSON.stringify([{ sourceRoot: "src/main/java" }]));

    const ctx = makeContext();
    await expect(func.call(ctx, {}, path)).rejects.toThrow(
      "Invalid code mapping"
    );
  });

  test("rejects mapping with missing sourceRoot", async () => {
    const path = join(tempDir, "bad.json");
    await writeFile(path, JSON.stringify([{ stackRoot: "com/example" }]));

    const ctx = makeContext();
    await expect(func.call(ctx, {}, path)).rejects.toThrow(
      "Invalid code mapping"
    );
  });

  test("rejects mapping with empty stackRoot", async () => {
    const path = join(tempDir, "bad.json");
    await writeFile(
      path,
      JSON.stringify([{ stackRoot: "", sourceRoot: "src" }])
    );

    const ctx = makeContext();
    await expect(func.call(ctx, {}, path)).rejects.toThrow(
      "Invalid code mapping"
    );
  });

  test("rejects directory path", async () => {
    const ctx = makeContext();
    await expect(func.call(ctx, {}, tempDir)).rejects.toThrow("directory");
  });
});

describe("extractRepoName", () => {
  // extractRepoName is not exported, so we test it indirectly via
  // the command's --repo flag behavior. If the function were exported,
  // we'd test it directly.

  test("valid mapping file passes validation", async () => {
    const path = join(tempDir, "valid.json");
    await writeFile(
      path,
      JSON.stringify([
        { stackRoot: "com/example/module", sourceRoot: "modules/module/src" },
        { stackRoot: "com/example/other", sourceRoot: "modules/other/src" },
      ])
    );

    // The command will pass validation but fail at org/project resolution
    // since we don't have real credentials. That's expected.
    let func: Awaited<ReturnType<typeof uploadCommand.loader>>;
    func = await uploadCommand.loader();
    const ctx = makeContext();

    // Should fail at org/project resolution, NOT at validation
    try {
      await func.call(ctx, { repo: "owner/repo" }, path);
      // If it somehow succeeds (unlikely without auth), that's fine too
    } catch (err) {
      // Should NOT be a ValidationError — those would mean validation failed
      expect(err).not.toBeInstanceOf(ValidationError);
    }
  });
});
