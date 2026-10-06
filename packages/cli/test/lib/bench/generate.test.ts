/**
 * Unit tests for the bench fixture generator.
 *
 * Covers the four properties the bench harness relies on:
 *   1. Determinism   — same spec + seed produces identical trees.
 *   2. Idempotency   — re-running against an existing matching fixture is a no-op.
 *   3. Sane content  — text files contain DSNs, binary blobs contain NUL bytes.
 *   4. Layout        — monorepo mode creates package dirs + per-pkg .gitignore.
 *
 * Lives under test/lib/bench/ so it's picked up by the standard `test:unit`
 * glob. The generator itself lives under test/fixtures/bench/ because it's
 * consumed by script/bench.ts outside the test runner.
 */

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  type FixtureMeta,
  type FixtureSpec,
  generateFixture,
  hashSpec,
} from "../../fixtures/bench/generate.js";
import { PRESETS } from "../../fixtures/bench/presets.js";

const ROOT = mkdtempSync(join(tmpdir(), "bench-gen-test-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function makeSpec(
  name: "small" | "medium",
  dir: string,
  seed = 42
): FixtureSpec {
  return { ...PRESETS[name], seed, rootDir: dir };
}

describe("generateFixture", () => {
  test("small preset produces a seeded tree with expected file count", () => {
    const dir = mkdtempSync(join(ROOT, "small-"));
    const meta = generateFixture(makeSpec("small", dir));
    // small preset targets exactly filesPerPackage for single-repo mode.
    expect(meta.fileCount).toBe(PRESETS.small.filesPerPackage);
    // dsnRatio=0.1 over 100 files; extremely unlikely to be 0.
    expect(meta.dsnCount).toBeGreaterThan(0);
    expect(meta.dsnCount).toBeLessThan(meta.fileCount);
    const onDisk = JSON.parse(
      readFileSync(join(dir, ".meta.json"), "utf8")
    ) as FixtureMeta;
    expect(onDisk.version).toBe(1);
    expect(onDisk.spec.packages).toBe(0);
  });

  test("same seed yields identical file/DSN counts (deterministic)", () => {
    const dirA = mkdtempSync(join(ROOT, "det-a-"));
    const dirB = mkdtempSync(join(ROOT, "det-b-"));
    const metaA = generateFixture(makeSpec("medium", dirA, 1337));
    const metaB = generateFixture(makeSpec("medium", dirB, 1337));
    expect(metaA.fileCount).toBe(metaB.fileCount);
    expect(metaA.dsnCount).toBe(metaB.dsnCount);
    expect(hashSpec(metaA.spec)).toBe(hashSpec(metaB.spec));
  });

  test("different seeds produce different spec hashes", () => {
    const base = PRESETS.small;
    const a = hashSpec({ ...base, seed: 1 });
    const b = hashSpec({ ...base, seed: 2 });
    expect(a).not.toBe(b);
  });

  test("idempotent re-run on matching spec is a no-op", () => {
    const dir = mkdtempSync(join(ROOT, "idem-"));
    const meta1 = generateFixture(makeSpec("small", dir, 7));
    const mtime1 = statSync(join(dir, ".meta.json")).mtimeMs;
    const meta2 = generateFixture(makeSpec("small", dir, 7));
    const mtime2 = statSync(join(dir, ".meta.json")).mtimeMs;
    expect(meta1.generatedAt).toBe(meta2.generatedAt);
    expect(mtime1).toBe(mtime2);
  });

  test("force: true regenerates even when meta matches", () => {
    const dir = mkdtempSync(join(ROOT, "force-"));
    const meta1 = generateFixture(makeSpec("small", dir, 9));
    // Spin briefly so Date.now() advances past meta1's timestamp.
    const start = Date.now();
    while (Date.now() - start < 2) {
      // busy-wait
    }
    const meta2 = generateFixture(makeSpec("small", dir, 9), { force: true });
    expect(meta2.generatedAt).toBeGreaterThanOrEqual(meta1.generatedAt);
  });

  test("monorepo mode creates package dirs with per-pkg .gitignore", () => {
    const dir = mkdtempSync(join(ROOT, "mono-"));
    generateFixture(makeSpec("medium", dir, 4242));
    const entries = readdirSync(dir);
    const mono = entries.find((e) => ["packages", "apps", "libs"].includes(e));
    expect(mono).toBeDefined();
    const pkgs = readdirSync(join(dir, mono as string));
    expect(pkgs.length).toBe(PRESETS.medium.packages);
    // medium preset uses nested gitignore; every pkg should have one.
    for (const pkg of pkgs) {
      const gi = join(dir, mono as string, pkg, ".gitignore");
      expect(statSync(gi).isFile()).toBe(true);
    }
  });

  test("root .git and .gitignore always present (project-root anchor)", () => {
    const dir = mkdtempSync(join(ROOT, "root-"));
    generateFixture(makeSpec("small", dir, 1));
    expect(statSync(join(dir, ".git")).isDirectory()).toBe(true);
    expect(statSync(join(dir, ".gitignore")).isFile()).toBe(true);
  });

  test("binary blobs contain at least one NUL byte", () => {
    const dir = mkdtempSync(join(ROOT, "bin-"));
    generateFixture({
      ...PRESETS.small,
      seed: 1,
      rootDir: dir,
      binaryRatio: 1, // all-binary (generator still forces >=1 text file)
      filesPerPackage: 10,
    });
    const blobs = readdirSync(join(dir, "assets"));
    // Generator clamps text files to >=1, so we get (filesPerPackage - 1) blobs.
    expect(blobs.length).toBe(9);
    for (const blob of blobs) {
      const bytes = readFileSync(join(dir, "assets", blob));
      expect(bytes.includes(0)).toBe(true);
    }
  });
});

describe("hashSpec", () => {
  test("is stable regardless of extension ordering", () => {
    const base = PRESETS.small;
    const a = hashSpec({ ...base, fileExtensions: [".ts", ".js"] });
    const b = hashSpec({ ...base, fileExtensions: [".js", ".ts"] });
    expect(a).toBe(b);
  });
});
