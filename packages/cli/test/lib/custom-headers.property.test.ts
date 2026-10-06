/**
 * Property-Based Tests for Custom Headers Parsing
 *
 * Uses fast-check to verify parsing invariants that should hold
 * for any valid header input.
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  nat,
  property,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { parseCustomHeaders } from "../../src/lib/custom-headers.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Characters valid in HTTP header names (subset of RFC 7230 token chars) */
const headerNameChars =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.!#$%&'*+^`|~";

/** Header names that cannot be used (reserved by the CLI) */
const FORBIDDEN_NAMES = new Set([
  "authorization",
  "host",
  "content-type",
  "content-length",
  "user-agent",
  "sentry-trace",
  "baggage",
]);

/** Generate a valid header name (1-30 chars, not forbidden) */
const headerNameArb = array(constantFrom(...headerNameChars.split("")), {
  minLength: 1,
  maxLength: 30,
})
  .map((chars) => chars.join(""))
  .filter((name) => !FORBIDDEN_NAMES.has(name.toLowerCase()));

/** Characters valid in header values (printable ASCII, no semicolons or newlines) */
const headerValueChars =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()-_=+[]{}|:',.<>?/`~";

/** Generate a header value (0-80 chars, no semicolons/newlines) */
const headerValueArb = array(constantFrom(...headerValueChars.split("")), {
  minLength: 0,
  maxLength: 80,
}).map((chars) => chars.join(""));

/** Generate a single valid header pair */
const headerPairArb = tuple(headerNameArb, headerValueArb);

/** Generate a list of 1-5 header pairs */
const headerListArb = array(headerPairArb, { minLength: 1, maxLength: 5 });

/** Separator: semicolon or newline */
const separatorArb = constantFrom("; ", ";\n", "\n");

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("property: parseCustomHeaders", () => {
  test("round-trip: format then parse returns same name/value pairs", () => {
    fcAssert(
      property(headerPairArb, ([name, value]) => {
        const formatted = `${name}: ${value}`;
        const result = parseCustomHeaders(formatted);
        expect(result).toEqual([[name, value.trim()]]);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("count: number of valid segments equals number of returned headers", () => {
    fcAssert(
      property(headerListArb, separatorArb, (pairs, sep) => {
        const formatted = pairs
          .map(([name, value]) => `${name}: ${value}`)
          .join(sep);
        const result = parseCustomHeaders(formatted);
        expect(result.length).toBe(pairs.length);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("order: headers appear in the same order as input", () => {
    fcAssert(
      property(headerListArb, (pairs) => {
        const formatted = pairs
          .map(([name, value]) => `${name}: ${value}`)
          .join("; ");
        const result = parseCustomHeaders(formatted);
        for (let i = 0; i < pairs.length; i++) {
          expect(result[i]?.[0]).toBe(pairs[i]?.[0]);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("values are always trimmed", () => {
    fcAssert(
      property(
        headerNameArb,
        headerValueArb,
        nat({ max: 5 }),
        nat({ max: 5 }),
        (name, value, leadingSpaces, trailingSpaces) => {
          const padded = `${" ".repeat(leadingSpaces)}${value}${" ".repeat(trailingSpaces)}`;
          const formatted = `${name}:${padded}`;
          const result = parseCustomHeaders(formatted);
          expect(result[0]?.[1]).toBe(value.trim());
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("empty segments between separators are skipped", () => {
    fcAssert(
      property(headerPairArb, ([name, value]) => {
        // Add empty segments via double-separators
        const formatted = `; ;${name}: ${value}; ; `;
        const result = parseCustomHeaders(formatted);
        expect(result.length).toBe(1);
        expect(result[0]?.[0]).toBe(name);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
