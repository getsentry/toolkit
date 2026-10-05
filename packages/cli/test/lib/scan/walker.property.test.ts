/**
 * Property tests for `walkFiles`.
 *
 * Two invariants we want to hold for any randomly generated tree:
 *
 *   1. Descent cap: no file yielded beyond `maxDepth + 1`. The walker
 *      caps directory *descent* at `maxDepth` — files inside those
 *      last-entered dirs still yield (they sit at parent_depth + 1).
 *   2. minDepth guarantee: for any tree, with `timeBudgetMs: 0` and a
 *      fixed `minDepth = N`, every file at depth ≤ N is yielded
 *      regardless of budget.
 *
 * Trees are built from a flat `(path, kind)` list. Generation is
 * constrained to ASCII alphanumerics + `_` to avoid tripping over the
 * `ignore` package's pattern escaping quirks.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  array,
  asyncProperty,
  constantFrom,
  assert as fcAssert,
  integer,
} from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { walkFiles } from "../../../src/lib/scan/walker.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

const ROOT = mkdtempSync(join(tmpdir(), "scan-walker-prop-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const SEGMENT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_".split("");
const segmentArb = array(constantFrom(...SEGMENT_CHARS), {
  minLength: 1,
  maxLength: 6,
}).map((chars) => chars.join(""));

/** An array of 1–5 path segments — describes a file relative to cwd. */
const filePathArb = array(segmentArb, { minLength: 1, maxLength: 5 });

function buildTree(cwd: string, paths: string[][]): void {
  for (const segs of paths) {
    const rel = `${segs.join("/")}.ts`;
    const abs = join(cwd, rel);
    const parent = abs.slice(0, abs.lastIndexOf("/"));
    mkdirSync(parent, { recursive: true });
    writeFileSync(abs, "x", "utf8");
  }
}

describe("property: walkFiles — invariants", () => {
  test("maxDepth: no file yielded beyond maxDepth + 1", async () => {
    // File depth = parent_dir_depth + 1. With maxDepth capping
    // descent at N, the deepest dir entered is at N, so files inside
    // it sit at N + 1. Files any deeper can't exist — their dir
    // wouldn't have been entered.
    await fcAssert(
      asyncProperty(
        array(filePathArb, { minLength: 0, maxLength: 20 }),
        integer({ min: 0, max: 5 }),
        async (paths, maxDepth) => {
          const cwd = mkdtempSync(join(ROOT, "depth-"));
          try {
            buildTree(cwd, paths);
            for await (const entry of walkFiles({ cwd, maxDepth })) {
              expect(entry.depth).toBeLessThanOrEqual(maxDepth + 1);
            }
          } finally {
            rmSync(cwd, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: Math.min(DEFAULT_NUM_RUNS, 20) }
    );
  });

  test(
    "minDepth guarantee: with budget=0 and clock advancing, " +
      "every file at depth <= minDepth still yields",
    async () => {
      await fcAssert(
        asyncProperty(
          array(filePathArb, { minLength: 0, maxLength: 20 }),
          integer({ min: 0, max: 5 }),
          async (paths, minDepth) => {
            const cwd = mkdtempSync(join(ROOT, "min-"));
            try {
              buildTree(cwd, paths);

              // Which file paths have depth ≤ minDepth? (depth N means
              // N-1 dir segments + filename, i.e., segments.length ≤ minDepth
              // when the file sits at depth N = segments.length.)
              const expected = new Set<string>();
              for (const segs of paths) {
                // File at depth === segs.length.
                if (segs.length <= minDepth) {
                  expected.add(`${segs.join("/")}.ts`);
                }
              }

              let now = 0;
              const yielded = new Set<string>();
              for await (const entry of walkFiles({
                cwd,
                minDepth,
                timeBudgetMs: 0,
                clock: () => {
                  now += 1000;
                  return now;
                },
              })) {
                yielded.add(entry.relativePath);
              }
              for (const expectedPath of expected) {
                expect(yielded.has(expectedPath)).toBe(true);
              }
            } finally {
              rmSync(cwd, { recursive: true, force: true });
            }
          }
        ),
        { numRuns: Math.min(DEFAULT_NUM_RUNS, 20) }
      );
    }
  );
});
