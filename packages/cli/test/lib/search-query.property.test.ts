/**
 * Property-based tests for search query sanitization.
 *
 * Covers invariants of `sanitizeQuery` from `src/lib/search-query.ts`:
 * - Same-key qualifier OR always rewrites to valid in-list
 * - Free-text OR always throws
 * - Different-key OR always throws
 * - AND stripping preserves all non-AND tokens
 * - Safe queries pass through unchanged
 */

import { constantFrom, assert as fcAssert, property, tuple } from "fast-check";
import { describe, expect, test } from "vitest";
import { ValidationError } from "../../src/lib/errors.js";
import { sanitizeQuery } from "../../src/lib/search-query.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

/** Keys that are valid for in-list syntax. */
const validInListKeyArb = constantFrom(
  "level",
  "browser",
  "assigned",
  "release",
  "message",
  "platform",
  "os.name",
  "transaction"
);

/** Keys that are NOT valid for in-list syntax. */
const invalidInListKeyArb = constantFrom("is", "has");

/** Simple values without wildcards, quotes, or brackets. */
const simpleValueArb = constantFrom(
  "error",
  "warning",
  "fatal",
  "info",
  "debug",
  "me",
  "none",
  "Chrome",
  "Firefox",
  "unresolved",
  "resolved"
);

/** Free-text terms (no colon → not a qualifier). */
const freeTextArb = constantFrom(
  "timeout",
  "crash",
  "sandbox",
  "order",
  "android",
  "poolexhaustion"
);

/** Safe terms that contain neither OR nor AND as standalone tokens. */
const safeTermArb = constantFrom(
  "is:unresolved",
  "level:error",
  "timeout",
  "crash",
  "http.status:500",
  "assigned:me",
  "sandbox",
  "order",
  "android"
);

describe("property: sanitizeQuery", () => {
  test("same-key qualifier OR rewrites to valid in-list", () => {
    fcAssert(
      property(
        validInListKeyArb,
        simpleValueArb,
        simpleValueArb,
        (key, val1, val2) => {
          const query = `${key}:${val1} OR ${key}:${val2}`;
          const result = sanitizeQuery(query);
          expect(result).toBe(`${key}:[${val1},${val2}]`);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("three-way same-key OR rewrites correctly", () => {
    fcAssert(
      property(
        validInListKeyArb,
        simpleValueArb,
        simpleValueArb,
        simpleValueArb,
        (key, v1, v2, v3) => {
          const query = `${key}:${v1} OR ${key}:${v2} OR ${key}:${v3}`;
          const result = sanitizeQuery(query);
          expect(result).toBe(`${key}:[${v1},${v2},${v3}]`);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("free-text OR always throws ValidationError", () => {
    fcAssert(
      property(
        tuple(freeTextArb, freeTextArb).map(([a, b]) => `${a} OR ${b}`),
        (query) => {
          expect(() => sanitizeQuery(query)).toThrow(ValidationError);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("different-key OR always throws ValidationError", () => {
    fcAssert(
      property(
        validInListKeyArb,
        validInListKeyArb,
        simpleValueArb,
        simpleValueArb,
        (key1, key2, val1, val2) => {
          // Only test when keys actually differ
          if (key1 === key2) {
            return;
          }
          const query = `${key1}:${val1} OR ${key2}:${val2}`;
          expect(() => sanitizeQuery(query)).toThrow(ValidationError);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("invalid-key OR (is/has) always throws ValidationError", () => {
    fcAssert(
      property(
        invalidInListKeyArb,
        simpleValueArb,
        simpleValueArb,
        (key, val1, val2) => {
          const query = `${key}:${val1} OR ${key}:${val2}`;
          expect(() => sanitizeQuery(query)).toThrow(ValidationError);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("AND removal preserves all non-AND tokens", () => {
    fcAssert(
      property(
        tuple(safeTermArb, safeTermArb).map(([a, b]) => `${a} AND ${b}`),
        (query) => {
          const result = sanitizeQuery(query);
          const parts = query.split(/\s+AND\s+/);
          for (const part of parts) {
            expect(result).toContain(part.trim());
          }
          // AND must not be present as standalone token
          expect(result).not.toMatch(/\bAND\b/);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("safe queries pass through unchanged", () => {
    fcAssert(
      property(safeTermArb, (term) => {
        expect(sanitizeQuery(term)).toBe(term);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
