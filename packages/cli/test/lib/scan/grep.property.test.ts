/**
 * Property test: `grepFiles` agrees with a naive reference impl.
 *
 * The invariant we're pinning: for any pattern + corpus,
 * `collectGrep` emits exactly the same matches as a naive
 * `content.split("\n").forEach(line => regex.test(line))` pass over
 * each file. Tests the engine's correctness without tying to any
 * specific implementation detail.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  array,
  asyncProperty,
  constantFrom,
  assert as fcAssert,
} from "fast-check";
import { afterAll, describe, expect, test } from "vitest";
import { collectGrep } from "../../../src/lib/scan/grep.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

const ROOT = mkdtempSync(join(tmpdir(), "scan-grep-prop-"));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Alphabet safe for filenames and file content (no newlines, no meta). */
const SAFE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

/** Short filename without extension metas. */
const filenameArb = array(constantFrom(...SAFE_CHARS), {
  minLength: 2,
  maxLength: 5,
}).map((chars) => `${chars.join("")}.txt`);

/**
 * File content: 1-8 lines, each 0-20 chars of SAFE_CHARS.
 *
 * We keep the character set small so generated patterns are
 * statistically likely to match a non-trivial number of lines.
 */
const fileContentArb = array(
  array(constantFrom(...SAFE_CHARS), { minLength: 0, maxLength: 20 }).map(
    (chars) => chars.join("")
  ),
  { minLength: 1, maxLength: 8 }
).map((lines) => lines.join("\n"));

/** Small tree: 1-5 filename/content pairs. */
const treeArb = array(
  constantFrom(null).chain(() =>
    filenameArb.chain((name) =>
      fileContentArb.map((content) => [name, content] as [string, string])
    )
  ),
  { minLength: 1, maxLength: 5 }
);

/** Pattern: 1-3 chars from the same alphabet — likely to match. */
const patternArb = array(constantFrom(...SAFE_CHARS), {
  minLength: 1,
  maxLength: 3,
}).map((chars) => chars.join(""));

/**
 * Naive reference: read each file's content directly, split by `\n`,
 * test each line against the regex, record matching lines with 1-based
 * line numbers. Sort by [path, lineNum] to align with collectGrep's
 * stable sort.
 */
type NaiveMatch = { path: string; lineNum: number; line: string };
function naiveGrep(
  layout: readonly [string, string][],
  pattern: string
): NaiveMatch[] {
  const out: NaiveMatch[] = [];
  const regex = new RegExp(pattern);
  for (const [path, content] of layout) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      if (regex.test(line)) {
        out.push({ path, lineNum: i + 1, line });
      }
    }
  }
  return out.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return a.lineNum - b.lineNum;
  });
}

describe("property: collectGrep matches naive reference", () => {
  test("every regex + corpus produces identical matches", async () => {
    await fcAssert(
      asyncProperty(treeArb, patternArb, async (pairs, pattern) => {
        // Dedupe paths — fc may generate duplicates, in which case
        // later entries overwrite earlier ones on disk but the naive
        // reference sees all. Drop duplicates from both sides.
        const seen = new Set<string>();
        const layout: [string, string][] = [];
        for (const [path, content] of pairs) {
          if (seen.has(path)) continue;
          seen.add(path);
          layout.push([path, content]);
        }
        const cwd = mkdtempSync(join(ROOT, "tree-"));
        try {
          for (const [path, content] of layout) {
            mkdirSync(cwd, { recursive: true });
            writeFileSync(join(cwd, path), content, "utf8");
          }
          const expected = naiveGrep(layout, pattern);
          const { matches } = await collectGrep({ cwd, pattern });
          const got = matches.map((m) => ({
            path: m.path,
            lineNum: m.lineNum,
            line: m.line,
          }));
          expect(got).toEqual(expected);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      }),
      // Filesystem-heavy property; keep run count modest so CI stays
      // fast. 20 runs still explores plenty of pattern/corpus shapes.
      { numRuns: Math.min(DEFAULT_NUM_RUNS, 20) }
    );
  });
});

describe("property: idempotence", () => {
  test("running collectGrep twice returns identical matches", async () => {
    await fcAssert(
      asyncProperty(treeArb, patternArb, async (pairs, pattern) => {
        const seen = new Set<string>();
        const layout: [string, string][] = [];
        for (const [path, content] of pairs) {
          if (seen.has(path)) continue;
          seen.add(path);
          layout.push([path, content]);
        }
        const cwd = mkdtempSync(join(ROOT, "tree-"));
        try {
          for (const [path, content] of layout) {
            mkdirSync(cwd, { recursive: true });
            writeFileSync(join(cwd, path), content, "utf8");
          }
          const a = await collectGrep({ cwd, pattern });
          const b = await collectGrep({ cwd, pattern });
          expect(a.matches).toEqual(b.matches);
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      }),
      { numRuns: Math.min(DEFAULT_NUM_RUNS, 15) }
    );
  });
});
