/**
 * Unit tests for the DIF scanner's I/O paths.
 *
 * Core filter invariants (format/id/feature matching, debug-id normalization)
 * are covered by the property-based tests in scan.property.test.ts. These tests
 * focus on filesystem behavior the property generators cannot express: the
 * `prepareDifs` size gate.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildDifFilters,
  prepareDifs,
  scanPaths,
} from "../../../src/lib/dif/scan.js";

/** A minimal, valid Breakpad symbol file with a known debug id. */
const BREAKPAD_FIXTURE = [
  "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
  "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
  "FUNC 1000 10 0 main",
  "1000 10 42 1",
  "PUBLIC 2000 0 some_symbol",
].join("\n");

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "df-scan-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("prepareDifs size gate", () => {
  test("keeps a file within the size limit", async () => {
    const path = join(tempDir, "ok.sym");
    await writeFile(path, BREAKPAD_FIXTURE);
    const files = await scanPaths([path]);
    const { prepared, oversizedCount } = await prepareDifs(
      files,
      buildDifFilters({}),
      { maxFileSize: 10 * 1024 }
    );
    expect(prepared).toHaveLength(1);
    expect(oversizedCount).toBe(0);
  });

  test("skips a file larger than the size limit and counts it", async () => {
    const path = join(tempDir, "big.sym");
    await writeFile(path, BREAKPAD_FIXTURE);
    const files = await scanPaths([path]);
    // The fixture is well over 1 byte, so a 1-byte cap drops it.
    const { prepared, oversizedCount } = await prepareDifs(
      files,
      buildDifFilters({}),
      { maxFileSize: 1 }
    );
    expect(prepared).toHaveLength(0);
    expect(oversizedCount).toBe(1);
  });

  test("no size limit (0/omitted) keeps the file", async () => {
    const path = join(tempDir, "nolimit.sym");
    await writeFile(path, BREAKPAD_FIXTURE);
    const files = await scanPaths([path]);
    const { prepared, oversizedCount } = await prepareDifs(
      files,
      buildDifFilters({})
    );
    expect(prepared).toHaveLength(1);
    expect(oversizedCount).toBe(0);
  });

  test("does not count an oversized file of an unrequested --type", async () => {
    const path = join(tempDir, "big.sym");
    await writeFile(path, BREAKPAD_FIXTURE);
    const files = await scanPaths([path]);
    // The fixture is a Breakpad file; with --type elf it is filtered out by the
    // header format check before the size gate, so it must not be counted as
    // oversized (which would otherwise misreport "all matched files too large").
    const { prepared, oversizedCount } = await prepareDifs(
      files,
      buildDifFilters({ types: ["elf"] }),
      { maxFileSize: 1 }
    );
    expect(prepared).toHaveLength(0);
    expect(oversizedCount).toBe(0);
  });

  test("counts an oversized file that matches the requested --type", async () => {
    const path = join(tempDir, "big.sym");
    await writeFile(path, BREAKPAD_FIXTURE);
    const files = await scanPaths([path]);
    const { prepared, oversizedCount } = await prepareDifs(
      files,
      buildDifFilters({ types: ["breakpad"] }),
      { maxFileSize: 1 }
    );
    expect(prepared).toHaveLength(0);
    expect(oversizedCount).toBe(1);
  });
});

describe("scanPaths traversal", () => {
  /** Map a list of file paths to their basenames for order-independent checks. */
  const names = (paths: string[]): string[] => paths.map((p) => basename(p));

  test("walks a directory recursively and returns nested files", async () => {
    await mkdir(join(tempDir, "sub"), { recursive: true });
    await writeFile(join(tempDir, "top.sym"), BREAKPAD_FIXTURE);
    await writeFile(join(tempDir, "sub", "nested.sym"), BREAKPAD_FIXTURE);

    const files = await scanPaths([tempDir]);

    expect(names(files).sort()).toEqual(["nested.sym", "top.sym"]);
  });

  test("keeps an explicit file argument as-is", async () => {
    const path = join(tempDir, "explicit.sym");
    await writeFile(path, BREAKPAD_FIXTURE);

    const files = await scanPaths([path]);

    expect(files).toEqual([path]);
  });

  test("discovers files under .gitignore'd and node_modules directories", async () => {
    // The walker's DSN-tuned defaults (respectGitignore + build-output
    // skip-dirs) would hide these; the DIF scanner must disable both because
    // debug files routinely live in gitignored build output.
    await writeFile(join(tempDir, ".gitignore"), "build/\nnode_modules/\n");
    await mkdir(join(tempDir, "build"), { recursive: true });
    await mkdir(join(tempDir, "node_modules"), { recursive: true });
    await writeFile(join(tempDir, "build", "ignored.sym"), BREAKPAD_FIXTURE);
    await writeFile(join(tempDir, "node_modules", "dep.sym"), BREAKPAD_FIXTURE);

    const found = names(await scanPaths([tempDir]));

    expect(found).toContain("ignored.sym");
    expect(found).toContain("dep.sym");
  });

  test("dedupes files reachable via overlapping arguments", async () => {
    await mkdir(join(tempDir, "sub"), { recursive: true });
    await writeFile(join(tempDir, "sub", "dup.sym"), BREAKPAD_FIXTURE);

    // The same file is reachable both via the parent dir walk and the explicit
    // nested-dir walk; it must appear exactly once.
    const files = await scanPaths([tempDir, join(tempDir, "sub")]);

    expect(names(files).filter((n) => n === "dup.sym")).toHaveLength(1);
  });

  test("is cycle-safe with a directory symlink loop", async () => {
    await mkdir(join(tempDir, "a"), { recursive: true });
    await writeFile(join(tempDir, "a", "real.sym"), BREAKPAD_FIXTURE);
    // A self-referential symlink would loop forever without cycle detection.
    await symlink(join(tempDir, "a"), join(tempDir, "a", "loop"));

    const found = names(await scanPaths([tempDir]));

    expect(found).toContain("real.sym");
  });

  test("throws ValidationError for a non-existent path", async () => {
    await expect(scanPaths([join(tempDir, "does-not-exist")])).rejects.toThrow(
      /does not exist/
    );
  });
});
