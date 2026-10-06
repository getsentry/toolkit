/**
 * Property-Based Tests for Local Dev Server Formatters
 *
 * Uses fast-check to verify invariants that should hold for any valid input.
 */

import {
  constantFrom,
  double,
  assert as fcAssert,
  integer,
  oneof,
  option,
  property,
  string,
  stringMatching,
} from "fast-check";
import { describe, expect, test } from "vitest";
import type { FilterValue } from "../../../src/lib/formatters/local.js";
import {
  FILTER_VALUES,
  formatTime,
  isItemIncluded,
  itemTypeToFilterCategory,
  sanitize,
} from "../../../src/lib/formatters/local.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

/** ANSI escape pattern — should not appear in sanitize output. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI control chars
const ANSI_RE = /\x1b\[[0-9;]*m/;

describe("property: sanitize", () => {
  test("output never contains ANSI escapes", () => {
    fcAssert(
      property(string(), (input) => {
        const result = sanitize(input);
        expect(ANSI_RE.test(result)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output never contains newlines", () => {
    fcAssert(
      property(string(), (input) => {
        const result = sanitize(input);
        expect(result).not.toContain("\n");
        expect(result).not.toContain("\r");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent: sanitize(sanitize(x)) === sanitize(x)", () => {
    fcAssert(
      property(string(), (input) => {
        const once = sanitize(input);
        const twice = sanitize(once);
        expect(twice).toBe(once);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: formatTime", () => {
  test("never throws for any number input", () => {
    fcAssert(
      property(double({ noNaN: false }), (n) => {
        const result = formatTime(n);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("never throws for any string input", () => {
    fcAssert(
      property(string(), (s) => {
        const result = formatTime(s);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("falsy number inputs (0, NaN) fall through to current time", () => {
    // NaN and 0 are falsy, so !timestamp is true → uses new Date()
    const result = formatTime(Number.NaN);
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    const result0 = formatTime(0);
    expect(result0).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("valid epoch seconds produce HH:MM:SS format", () => {
    fcAssert(
      property(integer({ min: 0, max: 4_102_444_800 }), (epoch) => {
        const result = formatTime(epoch);
        expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: isItemIncluded", () => {
  test("empty filter set always returns true", () => {
    const itemTypes = oneof(
      constantFrom(
        "error",
        "event",
        "transaction",
        "log",
        "attachment",
        "session"
      ),
      option(string(), { nil: undefined })
    );
    fcAssert(
      property(itemTypes, (itemType) => {
        const empty = new Set<FilterValue>();
        expect(isItemIncluded(itemType as string | undefined, empty)).toBe(
          true
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("known filter categories are self-consistent with itemTypeToFilterCategory", () => {
    const knownTypes = constantFrom("error", "event", "transaction", "log");
    const filterArb = constantFrom(...FILTER_VALUES);
    fcAssert(
      property(knownTypes, filterArb, (itemType, filter) => {
        const filters = new Set<FilterValue>([filter]);
        const category = itemTypeToFilterCategory(itemType);
        const included = isItemIncluded(itemType, filters);
        if (category === filter) {
          expect(included).toBe(true);
        } else {
          expect(included).toBe(false);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: itemTypeToFilterCategory", () => {
  test("error types map to error", () => {
    const errorTypes = constantFrom("error", "event");
    fcAssert(
      property(errorTypes, (itemType) => {
        expect(itemTypeToFilterCategory(itemType)).toBe("error");
      }),
      { numRuns: 10 }
    );
  });

  test("transaction maps to transaction", () => {
    expect(itemTypeToFilterCategory("transaction")).toBe("transaction");
  });

  test("log maps to log", () => {
    expect(itemTypeToFilterCategory("log")).toBe("log");
  });

  test("random non-matching strings return undefined", () => {
    const nonMatching = stringMatching(/^[a-z]{3,10}$/).filter(
      (s) =>
        s !== "error" && s !== "event" && s !== "transaction" && s !== "log"
    );
    fcAssert(
      property(nonMatching, (itemType) => {
        expect(itemTypeToFilterCategory(itemType)).toBeUndefined();
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("undefined input returns undefined", () => {
    expect(itemTypeToFilterCategory(undefined)).toBeUndefined();
  });
});
