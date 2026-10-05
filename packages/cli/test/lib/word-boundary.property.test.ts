/**
 * Property-Based Tests for Word Boundary Matching
 *
 * Tests the bidirectional word boundary matching logic used
 * for inferring projects from directory names.
 *
 * Uses fast-check to verify properties that should always hold true
 * for the matching functions, regardless of input.
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  property,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { matchesWordBoundary } from "../../src/lib/api-client.js";

// Arbitraries

/** Generate lowercase letters for slugs */
const lowerLetters = "abcdefghijklmnopqrstuvwxyz";

/** Generate alphanumeric characters for slugs */
const slugChars = `${lowerLetters}0123456789`;

/** Generate simple slugs (lowercase alphanumeric, no hyphens) */
const simpleSlugArb = array(constantFrom(...slugChars.split("")), {
  minLength: 2,
  maxLength: 15,
}).map((chars) => chars.join(""));

/** Generate a slug that contains another slug at word boundary */
const containingSlugArb = tuple(simpleSlugArb, simpleSlugArb).map(
  ([prefix, suffix]) => ({
    container: `${prefix}-${suffix}`,
    contained: prefix,
  })
);

/** Generate a slug that contains another slug at end */
const suffixContainingSlugArb = tuple(simpleSlugArb, simpleSlugArb).map(
  ([prefix, suffix]) => ({
    container: `${prefix}-${suffix}`,
    contained: suffix,
  })
);

// Properties for word boundary matching

describe("property: matchesWordBoundary symmetry", () => {
  test("exact match is always true", () => {
    fcAssert(
      property(simpleSlugArb, (slug) => {
        expect(matchesWordBoundary(slug, slug)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  test("matching is symmetric", () => {
    fcAssert(
      property(simpleSlugArb, simpleSlugArb, (a, b) => {
        // If a matches b, then b matches a
        expect(matchesWordBoundary(a, b)).toBe(matchesWordBoundary(b, a));
      }),
      { numRuns: 100 }
    );
  });

  test("case insensitive", () => {
    fcAssert(
      property(simpleSlugArb, (slug) => {
        const upper = slug.toUpperCase();
        const lower = slug.toLowerCase();
        const mixed = slug
          .split("")
          .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase()))
          .join("");

        expect(matchesWordBoundary(upper, lower)).toBe(true);
        expect(matchesWordBoundary(lower, mixed)).toBe(true);
        expect(matchesWordBoundary(upper, mixed)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});

describe("property: word boundary with hyphens", () => {
  test("prefix is found at word boundary", () => {
    fcAssert(
      property(containingSlugArb, ({ container, contained }) => {
        // "prefix" should match "prefix-suffix"
        expect(matchesWordBoundary(contained, container)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  test("suffix is found at word boundary", () => {
    fcAssert(
      property(suffixContainingSlugArb, ({ container, contained }) => {
        // "suffix" should match "prefix-suffix"
        expect(matchesWordBoundary(contained, container)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  test("middle part is found at word boundary", () => {
    fcAssert(
      property(
        tuple(simpleSlugArb, simpleSlugArb, simpleSlugArb),
        ([prefix, middle, suffix]) => {
          const container = `${prefix}-${middle}-${suffix}`;
          // "middle" should match "prefix-middle-suffix"
          expect(matchesWordBoundary(middle, container)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});

describe("property: non-matches", () => {
  test("substring without boundary does not match", () => {
    fcAssert(
      property(
        tuple(simpleSlugArb, simpleSlugArb, simpleSlugArb),
        ([prefix, infix, suffix]) => {
          // Concatenate without hyphens to avoid word boundaries
          const container = `${prefix}${infix}${suffix}`;

          // infix should NOT match if it's embedded without boundaries
          // (unless infix happens to be prefix or suffix, or equal to container)
          if (
            infix !== prefix &&
            infix !== suffix &&
            infix !== container &&
            !container.startsWith(infix) &&
            !container.endsWith(infix)
          ) {
            expect(matchesWordBoundary(infix, container)).toBe(false);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  test("completely different strings do not match", () => {
    fcAssert(
      property(simpleSlugArb, simpleSlugArb, (a, b) => {
        // Only check when strings share no common substrings >= 2 chars
        const hasCommonSubstring = () => {
          for (let i = 0; i <= a.length - 2; i++) {
            const sub = a.slice(i, i + 2);
            if (b.includes(sub)) return true;
          }
          return false;
        };

        // Strings with no common substrings shouldn't match
        // (unless one is a single char that appears in the other)
        if (!hasCommonSubstring() && a !== b && a.length > 1 && b.length > 1) {
          expect(matchesWordBoundary(a, b)).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe("property: underscore behavior", () => {
  test("underscore does NOT create word boundary", () => {
    fcAssert(
      property(simpleSlugArb, simpleSlugArb, (prefix, suffix) => {
        // In regex \b, underscore is part of \w (word characters)
        // So "prefix_suffix" does NOT have a word boundary between prefix and suffix
        const container = `${prefix}_${suffix}`;

        // prefix should NOT match at word boundary (underscore doesn't create boundary)
        // UNLESS prefix equals the entire container, or prefix/suffix are empty
        if (prefix !== container && prefix.length > 0 && suffix.length > 0) {
          expect(matchesWordBoundary(prefix, container)).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe("property: special regex characters are escaped", () => {
  test("dots in pattern are escaped", () => {
    // "a.b" should not match "axb" (dot should be literal)
    expect(matchesWordBoundary("a.b", "axb")).toBe(false);
    expect(matchesWordBoundary("a.b", "a.b")).toBe(true);
  });

  test("asterisks in pattern are escaped", () => {
    expect(matchesWordBoundary("a*b", "aaaaab")).toBe(false);
    expect(matchesWordBoundary("a*b", "a*b")).toBe(true);
  });

  test("question marks in pattern are escaped", () => {
    expect(matchesWordBoundary("a?b", "ab")).toBe(false);
    expect(matchesWordBoundary("a?b", "a?b")).toBe(true);
  });

  test("parentheses in pattern are escaped", () => {
    // Parentheses are escaped (doesn't create regex group)
    // But "(test)" won't match at word boundary because ( is not a word char
    // The important thing is it doesn't throw a regex error
    expect(() => matchesWordBoundary("(test)", "(test)")).not.toThrow();
    // However, the inner "test" part does match
    expect(matchesWordBoundary("test", "(test)")).toBe(true);
  });

  test("brackets in pattern are escaped", () => {
    // Brackets are escaped (doesn't create character class)
    // But "[test]" won't match at word boundary because [ is not a word char
    // The important thing is it doesn't throw a regex error
    expect(() => matchesWordBoundary("[test]", "[test]")).not.toThrow();
    // However, the inner "test" part does match
    expect(matchesWordBoundary("test", "[test]")).toBe(true);
  });
});
