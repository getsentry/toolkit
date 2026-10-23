/**
 * Tests for `debug-files wasm-upload` human output and the `--require-dwarf` gate.
 *
 * Output assertions cover the rendered string only; split and stamp behaviour is
 * covered by test/lib/wasm/prepare.test.ts.
 *
 * Vitest runs without a TTY, so `isPlainOutput()` is true and color tags are
 * stripped. That makes the expected strings stable and also proves plain mode
 * emits no stray tag markup.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { describe, expect, test, vi } from "vitest";
import {
  lacksDwarf,
  wasmUploadCommand,
} from "../../../src/commands/debug-files/wasm-upload.js";
import { ValidationError } from "../../../src/lib/errors.js";
import { COLORS } from "../../../src/lib/formatters/colors.js";
import { formatPrepareResult } from "../../../src/lib/formatters/wasm-prepare.js";
import type { PrepareResult } from "../../../src/lib/wasm/prepare.js";

/** A split module with every optional field populated. */
const splitModule: PrepareResult = {
  path: "web/assets/maze.wasm",
  action: "split",
  quality: "dwarf",
  buildId: "d5bcf04a000040008000000000000000",
  companion: "web/assets/maze.debug.wasm",
};

/** A skipped module carrying a warning. */
const skippedModule: PrepareResult = {
  path: "web/assets/maze.nosym.wasm",
  action: "skipped",
  quality: "none",
  buildId: "00000000000040008000000000000000",
  warning: "already stripped (build_id present, no debug sections)",
};

/** Render a report that uploaded nothing, for the given modules. */
function report(...modules: PrepareResult[]): string {
  return formatPrepareResult({
    uploaded: false,
    modules,
    filesUploaded: 0,
  });
}

describe("formatPrepareResult", () => {
  test("gives each module its own table, keyed by full path", () => {
    const output = report({
      ...splitModule,
      path: "/build/out/nested/app.wasm",
      companion: "/symbols/app.debug.wasm",
    });

    expect(output).toContain("/build/out/nested/app.wasm");
    expect(output).toContain("Action");
    expect(output).toContain("Split");
    expect(output).toContain("Debug quality");
    expect(output).toContain("dwarf");
    expect(output).toContain("d5bcf04a000040008000000000000000");
    expect(output).toContain("/symbols/app.debug.wasm");
  });

  test("attaches a warning and a recommendation to their own module", () => {
    const output = report({
      path: "app.wasm",
      action: "skipped",
      quality: "symtab",
      warning: "no line-level symbolication (name/symtab only)",
      recommendation: "verify build flags emit DWARF",
    });

    expect(output).toContain("Skipped");
    expect(output).toContain("Warning");
    expect(output).toContain("no line-level symbolication (name/symtab only)");
    expect(output).toContain("Recommendation");
    expect(output).toContain("verify build flags emit DWARF");
  });

  test("labels each action", () => {
    const label = (action: PrepareResult["action"]) =>
      report({ ...splitModule, action });

    expect(label("split")).toContain("Split");
    expect(label("would-split")).toContain("Would split");
    expect(label("already-prepared")).toContain("Already prepared");
    expect(label("skipped")).toContain("Skipped");
  });

  test("prints quality as the JSON payload spells it", () => {
    const output = report({ ...splitModule, quality: "external-debug-info" });

    expect(output).toContain("external-debug-info");
  });

  test("omits Build ID and Companion when absent", () => {
    const output = report({
      path: "app.wasm",
      action: "skipped",
      quality: "symtab",
    });

    expect(output).not.toContain("Build ID");
    expect(output).not.toContain("Companion");
  });

  test("does not let markdown in a path alter the output", () => {
    // Underscores are emphasis markers in markdown; a real filename keeps them.
    const output = report({ ...splitModule, path: "build/_my_module_.wasm" });

    expect(output).toContain("build/_my_module_.wasm");
  });

  test("keeps a dry-run companion placeholder intact", () => {
    // A dry run cannot know the random build id, so it reports the name as a
    // template. The angle brackets must survive rendering.
    const output = report({
      ...splitModule,
      action: "would-split",
      companion: "symbols/app.<build-id>.debug.wasm",
    });

    expect(output).toContain("symbols/app.<build-id>.debug.wasm");
  });

  test("opens with the scanned count and pluralizes it", () => {
    expect(report(splitModule).split("\n")[0]).toBe("Found 1 wasm file");
    expect(report(splitModule, skippedModule).split("\n")[0]).toBe(
      "Found 2 wasm files",
    );
  });

  test("reports the upload target only after an upload", () => {
    const uploaded = formatPrepareResult({
      org: "my-org",
      project: "my-project",
      uploaded: true,
      modules: [splitModule],
      filesUploaded: 1,
    });

    expect(uploaded).toContain("Uploaded 1 debug file to my-org/my-project");
    expect(report(splitModule)).not.toContain("Uploaded");
  });

  test("renders a summary alone when no modules were found", () => {
    expect(report()).toContain("Found 0 wasm files");
  });

  test("colors the skip label red in terminal output", () => {
    process.env.SENTRY_PLAIN_OUTPUT = "0";
    const level = chalk.level;
    chalk.level = 3;
    try {
      expect(report(skippedModule)).toContain(chalk.hex(COLORS.red)("Skipped"));
    } finally {
      chalk.level = level;
      delete process.env.SENTRY_PLAIN_OUTPUT;
    }
  });

  test("leaves no color tag markup in plain mode", () => {
    const output = formatPrepareResult({
      org: "my-org",
      project: "my-project",
      uploaded: true,
      modules: [splitModule, skippedModule],
      filesUploaded: 1,
    });

    expect(output).not.toMatch(/<\/?(muted|yellow|red|cyan)>/);
  });
});

describe("lacksDwarf", () => {
  const skipped = (quality: PrepareResult["quality"]): PrepareResult => ({
    path: "app.wasm",
    action: "skipped",
    quality,
  });

  test("fails a dangling external_debug_info pointer", () => {
    // The companion could not be resolved — a resolved one would have been
    // reported as already-prepared — so nothing reachable was uploaded.
    expect(lacksDwarf(skipped("external-debug-info"))).toBe(true);
  });

  test("fails a module with no usable debug info", () => {
    expect(lacksDwarf(skipped("symtab"))).toBe(true);
    expect(lacksDwarf(skipped("none"))).toBe(true);
  });

  test("passes a companion named directly on the command line", () => {
    expect(lacksDwarf(skipped("dwarf"))).toBe(false);
  });

  test("passes every module that produced a debug file", () => {
    expect(lacksDwarf(splitModule)).toBe(false);
    expect(lacksDwarf({ ...splitModule, action: "already-prepared" })).toBe(
      false,
    );
    expect(lacksDwarf({ ...splitModule, action: "would-split" })).toBe(false);
  });
});

describe("--build-id", () => {
  const BUILD_ID = "a1b2c3d4-e5f6-4788-99aa-bbccddeeff00";

  /** Run the command with `--build-id` over the given paths. */
  async function runWithBuildId(...paths: string[]): Promise<void> {
    const func = (await wasmUploadCommand.loader()) as unknown as (
      this: unknown,
      flags: Record<string, unknown>,
      ...rest: string[]
    ) => Promise<unknown>;
    const context = {
      stdout: { write: vi.fn(() => true) },
      stderr: { write: vi.fn(() => true) },
      cwd: "/tmp",
      env: {} as NodeJS.ProcessEnv,
      process: { ...process, exitCode: undefined } as typeof process,
    };
    await func.call(
      context,
      { "build-id": BUILD_ID, "dry-run": true, "no-upload": true },
      ...paths,
    );
  }

  /** A directory holding one module, so only the path kind is under test. */
  async function moduleDir(): Promise<{ dir: string; module: string }> {
    const dir = await mkdtemp(join(tmpdir(), "prepare-build-id-"));
    const module = join(dir, "app.wasm");
    await writeFile(module, Uint8Array.from([0x00, 0x61, 0x73, 0x6d]));
    return { dir, module };
  }

  test("is refused for a directory, which may hold several modules", async () => {
    const { dir } = await moduleDir();

    await expect(runWithBuildId(dir)).rejects.toThrow(ValidationError);
  });

  test("is refused for several paths", async () => {
    const { module } = await moduleDir();
    const second = await moduleDir();

    await expect(runWithBuildId(module, second.module)).rejects.toThrow(
      /single .wasm file/,
    );
  });

  test("is accepted for one named module", async () => {
    const { module } = await moduleDir();

    await expect(runWithBuildId(module)).resolves.toBeUndefined();
  });
});
