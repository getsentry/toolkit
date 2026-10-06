/**
 * Property test: a root-only IgnoreStack behaves identically to a
 * plain `ignore` instance.
 *
 * This isn't a full cumulative-semantics test (the nested case is
 * covered by the unit tests) — it's a round-trip anchor so refactors
 * to the stack's root path can't silently diverge from the upstream
 * package.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  array,
  asyncProperty,
  constantFrom,
  assert as fcAssert,
} from "fast-check";
import ignore from "ignore";
import { afterAll, describe, expect, test } from "vitest";
import { IgnoreStack } from "../../../src/lib/scan/ignore.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

const ROOT = mkdtempSync(join(tmpdir(), "scan-ignore-prop-"));

/** Safe path-segment alphabet — no dots, slashes, or whitespace. */
const SEGMENT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_-".split("");

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * Arbitrary for well-formed relative POSIX path segments.
 *
 * Constrained to [a-z0-9_-] so we don't accidentally generate strings
 * the `ignore` package treats specially (whitespace, leading `.`/`!`,
 * glob metas, path separators).
 */
const segmentArb = array(constantFrom(...SEGMENT_CHARS), {
  minLength: 1,
  maxLength: 10,
}).map((chars) => chars.join(""));
const relPathArb = array(segmentArb, { minLength: 1, maxLength: 4 }).map((xs) =>
  xs.join("/")
);
/**
 * Pattern alphabet kept small and safe — the `ignore` package treats
 * many characters with special semantics (e.g. `\`, `[`, `{`) that we
 * don't want to explore at the boundary here.
 */
const patternArb = constantFrom(
  "*.log",
  "*.tmp",
  "build",
  "dist/",
  "node_modules",
  "*.bak",
  "src/**/*.generated.ts",
  "coverage",
  ".env"
);

describe("property: IgnoreStack root-only == plain ignore instance", () => {
  test("isIgnored matches `ignore` for root-only patterns", async () => {
    await fcAssert(
      asyncProperty(
        array(patternArb, { minLength: 0, maxLength: 6 }),
        relPathArb,
        async (patterns, relPath) => {
          const cwd = mkdtempSync(join(ROOT, "rt-"));
          try {
            if (patterns.length > 0) {
              writeFileSync(
                join(cwd, ".gitignore"),
                `${patterns.join("\n")}\n`,
                "utf8"
              );
            }
            const stack = await IgnoreStack.create({
              cwd,
              alwaysSkipDirs: [],
            });
            const plain = ignore().add(patterns);
            expect(stack.isIgnored(relPath, false)).toBe(
              plain.ignores(relPath)
            );
          } finally {
            rmSync(cwd, { recursive: true, force: true });
          }
        }
      ),
      // Fewer runs: each run writes fs state. 25 is enough to catch
      // regressions without blowing up CI time.
      { numRuns: Math.min(DEFAULT_NUM_RUNS, 25) }
    );
  });
});

describe("property: alwaysSkipDirs always ignore their basename", () => {
  test("skipped-dir basenames are always ignored", async () => {
    await fcAssert(
      asyncProperty(
        constantFrom("node_modules", "dist", ".git", "venv"),
        relPathArb,
        async (skipDir, trailing) => {
          const cwd = mkdtempSync(join(ROOT, "skip-"));
          try {
            // Ensure the skip dir appears as a segment in the query.
            const rel = `${skipDir}/${trailing}`;
            const stack = await IgnoreStack.create({
              cwd,
              alwaysSkipDirs: [skipDir],
            });
            expect(stack.isIgnored(rel, false)).toBe(true);
          } finally {
            rmSync(cwd, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: Math.min(DEFAULT_NUM_RUNS, 25) }
    );
  });
});
