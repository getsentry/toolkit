/**
 * Property tests for shared constants in `src/lib/scan/constants.ts`.
 *
 * `normalizePath` is trivially identity on POSIX and a regex replace on
 * Windows. We use property-based tests anyway because the identity case
 * is easy to silently break (e.g., someone switches to `path.normalize`
 * which collapses `a/b/../c` to `a/c` — that would not be idempotent).
 */

import path from "node:path";
import {
  constantFrom,
  assert as fcAssert,
  property,
  string,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  isMonorepoPackageDir,
  MONOREPO_ROOTS,
  normalizePath,
} from "../../../src/lib/scan/constants.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

describe("property: normalizePath", () => {
  test("idempotent", () => {
    fcAssert(
      property(string(), (input) => {
        const once = normalizePath(input);
        const twice = normalizePath(once);
        expect(twice).toBe(once);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("no backslashes in output on non-POSIX platforms", () => {
    if (path.sep === path.posix.sep) {
      // Identity on POSIX — backslashes are a valid filename character
      // there, so preserving them is the correct behavior.
      return;
    }
    fcAssert(
      property(string(), (input) => {
        expect(normalizePath(input).includes("\\")).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("POSIX: identity", () => {
    if (path.sep !== path.posix.sep) {
      return;
    }
    fcAssert(
      property(string(), (input) => {
        expect(normalizePath(input)).toBe(input);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: isMonorepoPackageDir", () => {
  const segmentArb = string({ minLength: 1, maxLength: 15 }).filter(
    (s) => !s.includes("/") && s.length > 0
  );

  test("any 2-segment path with MONOREPO_ROOTS first is a package dir", () => {
    fcAssert(
      property(constantFrom(...MONOREPO_ROOTS), segmentArb, (root, pkg) => {
        const rel = `${root}/${pkg}`;
        expect(isMonorepoPackageDir(rel)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("single-segment paths are never package dirs", () => {
    fcAssert(
      property(segmentArb, (seg) => {
        expect(isMonorepoPackageDir(seg)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("3-segment paths are never package dirs even with monorepo root", () => {
    fcAssert(
      property(
        constantFrom(...MONOREPO_ROOTS),
        tuple(segmentArb, segmentArb),
        (root, [b, c]) => {
          expect(isMonorepoPackageDir(`${root}/${b}/${c}`)).toBe(false);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("2-segment paths with non-monorepo first segment are not package dirs", () => {
    // Filter out any MONOREPO_ROOTS member so we exercise the negative case.
    const monorepoSet = new Set<string>(MONOREPO_ROOTS);
    fcAssert(
      property(segmentArb, segmentArb, (first, second) => {
        if (monorepoSet.has(first)) {
          return; // skip — tested above
        }
        expect(isMonorepoPackageDir(`${first}/${second}`)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("DEFAULT_SKIP_DIRS vs DSN_ADDITIONAL_SKIP_DIRS", () => {
  test("no overlap between the two skip lists", () => {
    // Overlapping entries would be a code-smell: either they move into
    // DEFAULT_SKIP_DIRS (and DSN_ADDITIONAL_SKIP_DIRS drops them) or
    // they're DSN-specific (and shouldn't be in both).
    const fn = async () => {
      const { DEFAULT_SKIP_DIRS, DSN_ADDITIONAL_SKIP_DIRS } = await import(
        "../../../src/lib/scan/constants.js"
      );
      const base = new Set(DEFAULT_SKIP_DIRS);
      for (const extra of DSN_ADDITIONAL_SKIP_DIRS) {
        expect(base.has(extra)).toBe(false);
      }
    };
    return fn();
  });
});
