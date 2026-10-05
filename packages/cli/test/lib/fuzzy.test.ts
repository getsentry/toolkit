/**
 * Fuzzy Matching Tests
 *
 * Property-based and unit tests for Levenshtein distance and fuzzyMatch.
 * Core invariants are tested via properties; edge cases and specific
 * output formatting are tested via unit tests.
 */

import { array, assert as fcAssert, property, string } from "fast-check";
import { describe, expect, test } from "vitest";
import { fuzzyMatch, levenshtein } from "../../src/lib/fuzzy.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Short strings to keep Levenshtein computation fast in property tests
const shortStringArb = string({ minLength: 0, maxLength: 20 });

describe("property: levenshtein", () => {
  test("identity: distance to self is always 0", () => {
    fcAssert(
      property(shortStringArb, (s) => {
        expect(levenshtein(s, s)).toBe(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("symmetry: levenshtein(a, b) === levenshtein(b, a)", () => {
    fcAssert(
      property(shortStringArb, shortStringArb, (a, b) => {
        expect(levenshtein(a, b)).toBe(levenshtein(b, a));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("upper bound: distance <= max(a.length, b.length)", () => {
    fcAssert(
      property(shortStringArb, shortStringArb, (a, b) => {
        const dist = levenshtein(a, b);
        expect(dist).toBeLessThanOrEqual(Math.max(a.length, b.length));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("non-negative: distance is always >= 0", () => {
    fcAssert(
      property(shortStringArb, shortStringArb, (a, b) => {
        expect(levenshtein(a, b)).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty string: distance to empty is the string length", () => {
    fcAssert(
      property(shortStringArb, (s) => {
        expect(levenshtein(s, "")).toBe(s.length);
        expect(levenshtein("", s)).toBe(s.length);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("triangle inequality: d(a,c) <= d(a,b) + d(b,c)", () => {
    fcAssert(
      property(shortStringArb, shortStringArb, shortStringArb, (a, b, c) => {
        const dac = levenshtein(a, c);
        const dab = levenshtein(a, b);
        const dbc = levenshtein(b, c);
        expect(dac).toBeLessThanOrEqual(dab + dbc);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("levenshtein: unit tests", () => {
  test("known distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("saturday", "sunday")).toBe(3);
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("a", "b")).toBe(1);
    expect(levenshtein("abc", "abc")).toBe(0);
  });
});

describe("fuzzyMatch: unit tests", () => {
  const candidates = ["sentry", "entry", "notary", "sentinel", "send", "zen"];

  test("empty partial returns all candidates sorted", () => {
    const result = fuzzyMatch("", candidates);
    expect(result).toEqual([...candidates].sort());
  });

  test("exact match ranks first", () => {
    const result = fuzzyMatch("sentry", candidates);
    expect(result[0]).toBe("sentry");
  });

  test("prefix matches rank high", () => {
    const result = fuzzyMatch("sen", candidates);
    expect(result).toContain("sentry");
    expect(result).toContain("sentinel");
    expect(result).toContain("send");
    // "sen" is a prefix of all three
    expect(result.indexOf("sentry")).toBeLessThan(result.length);
  });

  test("contains matches are included", () => {
    const result = fuzzyMatch("try", candidates);
    // "try" is contained in "sentry" and "entry"
    expect(result).toContain("sentry");
    expect(result).toContain("entry");
  });

  test("fuzzy match on typo: senry → sentry", () => {
    // "senry" has length 5, threshold = max(2, floor(5/3)) = 2
    // levenshtein("senry", "sentry") = 1 (insert 't')
    const result = fuzzyMatch("senry", candidates);
    expect(result).toContain("sentry");
  });

  test("fuzzy match on typo: entry → sentry, entry (exact + fuzzy)", () => {
    // "entry" exact matches "entry" and is distance 2 from "sentry"
    const result = fuzzyMatch("entry", candidates);
    expect(result[0]).toBe("entry"); // exact match first
    expect(result).toContain("sentry"); // fuzzy match (distance 2)
  });

  test("case-insensitive matching", () => {
    const result = fuzzyMatch("SENTRY", candidates);
    expect(result[0]).toBe("sentry");
  });

  test("maxResults limits output", () => {
    const result = fuzzyMatch("", candidates, { maxResults: 2 });
    expect(result.length).toBe(2);
  });

  test("no matches returns empty array", () => {
    const result = fuzzyMatch("zzzzzzzzz", candidates);
    expect(result).toEqual([]);
  });

  test("prefix matches come before contains matches", () => {
    const items = ["prefix-match", "contains-prefix", "no-match"];
    const result = fuzzyMatch("prefix", items);
    expect(result.indexOf("prefix-match")).toBeLessThan(
      result.indexOf("contains-prefix")
    );
  });
});

describe("property: fuzzyMatch", () => {
  test("exact candidate is always in the result", () => {
    const candidatesArb = array(shortStringArb, {
      minLength: 1,
      maxLength: 10,
    });
    fcAssert(
      property(candidatesArb, (candidates) => {
        // Pick the first candidate as partial
        const partial = candidates[0];
        const result = fuzzyMatch(partial, candidates);
        expect(result).toContain(partial);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty partial returns all candidates", () => {
    const candidatesArb = array(shortStringArb, {
      minLength: 0,
      maxLength: 10,
    });
    fcAssert(
      property(candidatesArb, (candidates) => {
        const result = fuzzyMatch("", candidates);
        expect(result.length).toBe(candidates.length);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result is a subset of candidates", () => {
    const candidatesArb = array(shortStringArb, {
      minLength: 0,
      maxLength: 10,
    });
    fcAssert(
      property(shortStringArb, candidatesArb, (partial, candidates) => {
        const result = fuzzyMatch(partial, candidates);
        for (const r of result) {
          expect(candidates).toContain(r);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
