/**
 * Property-Based Tests for Issue ID Parsing
 *
 * Uses fast-check to verify properties that should always hold true
 * for the issue ID parsing functions, regardless of input.
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  nat,
  property,
  string,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  expandToFullShortId,
  isShortId,
  isShortSuffix,
  parseAliasSuffix,
} from "../../src/lib/issue-id.js";
import { isAllDigits } from "../../src/lib/utils.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Arbitraries

/** Generate pure digit strings */
const numericArb = array(constantFrom(..."0123456789".split("")), {
  minLength: 1,
  maxLength: 20,
}).map((chars) => chars.join(""));

/** Generate alphanumeric strings with at least one letter */
const alphanumericWithLetterArb = tuple(
  array(
    constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
    ),
    {
      minLength: 1,
      maxLength: 10,
    }
  ),
  array(constantFrom(..."0123456789".split("")), { minLength: 0, maxLength: 5 })
).map(([letters, digits]) => [...letters, ...digits].join(""));

/** Generate valid project slugs (lowercase alphanumeric with hyphens) */
const projectSlugArb = array(
  constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-".split("")),
  {
    minLength: 1,
    maxLength: 30,
  }
)
  .map((chars) => chars.join(""))
  .filter((s) => !(s.startsWith("-") || s.endsWith("-")) && s.length > 0);

/** Generate valid short suffixes (alphanumeric, no hyphens) */
const shortSuffixArb = array(
  constantFrom(
    ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(
      ""
    )
  ),
  { minLength: 1, maxLength: 10 }
).map((chars) => chars.join(""));

/** Generate alias-suffix format strings */
const aliasSuffixFormatArb = tuple(
  array(constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
    minLength: 1,
    maxLength: 10,
  }),
  shortSuffixArb
).map(([aliasChars, suffix]) => `${aliasChars.join("")}-${suffix}`);

// Properties for isAllDigits

describe("property: isAllDigits", () => {
  test("returns true for all pure digit strings", () => {
    fcAssert(
      property(numericArb, (digits) => {
        expect(isAllDigits(digits)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns false for strings containing letters", () => {
    fcAssert(
      property(alphanumericWithLetterArb, (str) => {
        expect(isAllDigits(str)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns false for strings containing hyphens", () => {
    fcAssert(
      property(tuple(numericArb, numericArb), ([a, b]) => {
        const withHyphen = `${a}-${b}`;
        expect(isAllDigits(withHyphen)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty string returns false", () => {
    expect(isAllDigits("")).toBe(false);
  });

  test("nat() values converted to string are always numeric", () => {
    fcAssert(
      property(nat(999_999_999), (n) => {
        expect(isAllDigits(String(n))).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Properties for isShortSuffix

describe("property: isShortSuffix", () => {
  test("returns true for alphanumeric strings without hyphens", () => {
    fcAssert(
      property(shortSuffixArb, (suffix) => {
        expect(isShortSuffix(suffix)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns false for any string containing hyphens", () => {
    fcAssert(
      property(tuple(shortSuffixArb, shortSuffixArb), ([a, b]) => {
        const withHyphen = `${a}-${b}`;
        expect(isShortSuffix(withHyphen)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("pure numeric strings are valid short suffixes", () => {
    fcAssert(
      property(numericArb, (digits) => {
        expect(isShortSuffix(digits)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns false for strings with special characters", () => {
    const specialChars = "!@#$%^&*()_+=[]{}|;':\",./<>?`~ ";
    fcAssert(
      property(
        tuple(shortSuffixArb, constantFrom(...specialChars.split(""))),
        ([suffix, special]) => {
          expect(isShortSuffix(suffix + special)).toBe(false);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Properties for isShortId

describe("property: isShortId", () => {
  test("returns true for any string containing at least one letter", () => {
    fcAssert(
      property(alphanumericWithLetterArb, (str) => {
        expect(isShortId(str)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns false for pure numeric strings", () => {
    fcAssert(
      property(numericArb, (digits) => {
        expect(isShortId(digits)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("isShortId and isAllDigits are mutually exclusive for non-empty alphanumeric strings", () => {
    fcAssert(
      property(
        tuple(shortSuffixArb, constantFrom(true, false)),
        ([base, addLetter]) => {
          // Create either pure numeric or alphanumeric with letter
          const str = addLetter ? base : base.replace(/[a-zA-Z]/g, "0");
          if (str.length === 0) return; // Skip empty

          // At most one can be true
          const isShort = isShortId(str);
          const isNumeric = isAllDigits(str);
          expect(isShort && isNumeric).toBe(false);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Properties for parseAliasSuffix

describe("property: parseAliasSuffix", () => {
  test("successfully parses valid alias-suffix format", () => {
    fcAssert(
      property(aliasSuffixFormatArb, (input) => {
        const result = parseAliasSuffix(input);
        expect(result).not.toBeNull();
        expect(result?.alias).toBeDefined();
        expect(result?.suffix).toBeDefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("alias is always lowercase", () => {
    fcAssert(
      property(aliasSuffixFormatArb, (input) => {
        const result = parseAliasSuffix(input);
        if (result) {
          expect(result.alias).toBe(result.alias.toLowerCase());
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("suffix is always uppercase", () => {
    fcAssert(
      property(aliasSuffixFormatArb, (input) => {
        const result = parseAliasSuffix(input);
        if (result) {
          expect(result.suffix).toBe(result.suffix.toUpperCase());
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("returns null for strings without hyphens", () => {
    fcAssert(
      property(shortSuffixArb, (input) => {
        // shortSuffixArb has no hyphens
        const result = parseAliasSuffix(input);
        expect(result).toBeNull();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("parsed alias + suffix reconstruct to original input (case-insensitive)", () => {
    fcAssert(
      property(aliasSuffixFormatArb, (input) => {
        const result = parseAliasSuffix(input);
        if (result) {
          // Verify round-trip: reconstructed form matches original input
          const reconstructed = `${result.alias}-${result.suffix}`;
          expect(reconstructed.toLowerCase()).toBe(input.toLowerCase());
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Properties for expandToFullShortId

describe("property: expandToFullShortId", () => {
  test("result is always uppercase", () => {
    fcAssert(
      property(
        tuple(shortSuffixArb, projectSlugArb),
        ([suffix, projectSlug]) => {
          const result = expandToFullShortId(suffix, projectSlug);
          expect(result).toBe(result.toUpperCase());
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result contains hyphen separator", () => {
    fcAssert(
      property(
        tuple(shortSuffixArb, projectSlugArb),
        ([suffix, projectSlug]) => {
          const result = expandToFullShortId(suffix, projectSlug);
          expect(result).toContain("-");
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result ends with uppercase suffix", () => {
    fcAssert(
      property(
        tuple(shortSuffixArb, projectSlugArb),
        ([suffix, projectSlug]) => {
          const result = expandToFullShortId(suffix, projectSlug);
          expect(result.endsWith(suffix.toUpperCase())).toBe(true);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result starts with uppercase project slug", () => {
    fcAssert(
      property(
        tuple(shortSuffixArb, projectSlugArb),
        ([suffix, projectSlug]) => {
          const result = expandToFullShortId(suffix, projectSlug);
          expect(result.startsWith(projectSlug.toUpperCase())).toBe(true);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("result format is PROJECT-SUFFIX", () => {
    fcAssert(
      property(
        tuple(shortSuffixArb, projectSlugArb),
        ([suffix, projectSlug]) => {
          const result = expandToFullShortId(suffix, projectSlug);
          const expected = `${projectSlug.toUpperCase()}-${suffix.toUpperCase()}`;
          expect(result).toBe(expected);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("is idempotent when inputs are already uppercase", () => {
    fcAssert(
      property(
        tuple(shortSuffixArb, projectSlugArb),
        ([suffix, projectSlug]) => {
          const result1 = expandToFullShortId(suffix, projectSlug);
          const result2 = expandToFullShortId(
            suffix.toUpperCase(),
            projectSlug.toUpperCase()
          );
          expect(result1).toBe(result2);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

// Cross-function Properties

describe("property: cross-function invariants", () => {
  test("expanded short IDs are always detected as short IDs", () => {
    fcAssert(
      property(
        tuple(shortSuffixArb, projectSlugArb),
        ([suffix, projectSlug]) => {
          // Skip if suffix is pure numeric (would make the whole thing numeric)
          if (isAllDigits(suffix)) return;

          const expanded = expandToFullShortId(suffix, projectSlug);
          expect(isShortId(expanded)).toBe(true);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("parseAliasSuffix result can be expanded back", () => {
    fcAssert(
      property(aliasSuffixFormatArb, (input) => {
        const parsed = parseAliasSuffix(input);
        if (parsed) {
          // Use alias as project slug for expansion
          const expanded = expandToFullShortId(parsed.suffix, parsed.alias);
          expect(expanded).toBe(
            `${parsed.alias.toUpperCase()}-${parsed.suffix}`
          );
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("random strings are categorized consistently", () => {
    fcAssert(
      property(string({ minLength: 1, maxLength: 50 }), (input) => {
        // Every non-empty string should be categorized into at most one type:
        // - isAllDigits (pure digits)
        // - isShortId (contains letters)
        // - neither (empty, which we filter out)

        const numeric = isAllDigits(input);
        const short = isShortId(input);

        // Can't be both
        expect(numeric && short).toBe(false);

        // If it's alphanumeric, should be one or the other
        const isAlphanumeric = /^[a-zA-Z0-9]+$/.test(input);
        if (isAlphanumeric && input.length > 0) {
          expect(numeric || short).toBe(true);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
