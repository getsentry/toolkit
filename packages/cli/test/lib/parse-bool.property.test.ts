/**
 * Property-based tests for parseBoolValue.
 *
 * Verifies that the boolean parser correctly handles all recognized
 * true/false values, arbitrary casing, whitespace padding, and
 * returns null for unrecognized input.
 */

import {
  constantFrom,
  assert as fcAssert,
  property,
  string,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { parseBoolValue } from "../../src/lib/parse-bool.js";

const DEFAULT_NUM_RUNS = 50;

/** Known true string values (canonical lowercase) */
const TRUTHY_STRINGS = ["true", "t", "y", "yes", "on", "1"] as const;

/** Known false string values (canonical lowercase) */
const FALSY_STRINGS = ["false", "f", "n", "no", "off", "0"] as const;

/** Arbitrary that generates a known truthy value */
const truthyArb = constantFrom(...TRUTHY_STRINGS);

/** Arbitrary that generates a known falsy value */
const falsyArb = constantFrom(...FALSY_STRINGS);

/**
 * Arbitrary that randomizes case of each character in a string.
 * E.g., "yes" → "yEs", "YES", "Yes", etc.
 */
function randomCase(input: string): string {
  return input
    .split("")
    .map((c) => (Math.random() > 0.5 ? c.toUpperCase() : c.toLowerCase()))
    .join("");
}

/** Arbitrary for whitespace padding (spaces and tabs only) */
const whitespaceArb = constantFrom("", " ", "  ", "\t", " \t ");

describe("property: parseBoolValue", () => {
  test("all known truthy values → true", () => {
    fcAssert(
      property(truthyArb, (input) => {
        expect(parseBoolValue(input)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("all known falsy values → false", () => {
    fcAssert(
      property(falsyArb, (input) => {
        expect(parseBoolValue(input)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("truthy values are case-insensitive", () => {
    fcAssert(
      property(truthyArb, (input) => {
        const cased = randomCase(input);
        expect(parseBoolValue(cased)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("falsy values are case-insensitive", () => {
    fcAssert(
      property(falsyArb, (input) => {
        const cased = randomCase(input);
        expect(parseBoolValue(cased)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("truthy values with whitespace padding → true", () => {
    fcAssert(
      property(
        tuple(whitespaceArb, truthyArb, whitespaceArb),
        ([pre, val, post]) => {
          expect(parseBoolValue(`${pre}${val}${post}`)).toBe(true);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("falsy values with whitespace padding → false", () => {
    fcAssert(
      property(
        tuple(whitespaceArb, falsyArb, whitespaceArb),
        ([pre, val, post]) => {
          expect(parseBoolValue(`${pre}${val}${post}`)).toBe(false);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("unrecognized values → null", () => {
    fcAssert(
      property(string(), (input) => {
        const result = parseBoolValue(input);
        // If the result is not null, the input must be a recognized value
        if (result !== null) {
          const normalized = input.toLowerCase().trim();
          const recognized = [
            "true",
            "t",
            "y",
            "yes",
            "on",
            "1",
            "false",
            "f",
            "n",
            "no",
            "off",
            "0",
          ];
          expect(recognized).toContain(normalized);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS * 2 }
    );
  });

  test("never throws", () => {
    fcAssert(
      property(string(), (input) => {
        // Should never throw, always returns boolean | null
        const result = parseBoolValue(input);
        expect(result === true || result === false || result === null).toBe(
          true
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
