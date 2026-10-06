/**
 * Property-Based Tests for src/lib/utils.ts
 *
 * Verifies invariants that should hold for any input to slugify, regardless
 * of the characters present.
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  property,
  string,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { slugify } from "../../src/lib/utils.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

/** Mix of valid slug chars, separators, scope/path glyphs, whitespace, and unicode */
const messyChars =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" +
  "_-/\\@.: \tCaféñü漢";

const messyInputArb = array(constantFrom(...messyChars.split("")), {
  minLength: 0,
  maxLength: 30,
}).map((chars) => chars.join(""));

const VALID_SLUG_RE = /^[a-z0-9_-]*$/;

describe("property: slugify", () => {
  test("output contains only [a-z0-9_-]", () => {
    fcAssert(
      property(messyInputArb, (input) => {
        expect(slugify(input)).toMatch(VALID_SLUG_RE);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output never starts or ends with a hyphen", () => {
    fcAssert(
      property(messyInputArb, (input) => {
        const out = slugify(input);
        if (out.length > 0) {
          expect(out.startsWith("-")).toBe(false);
          expect(out.endsWith("-")).toBe(false);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("output never contains consecutive hyphens", () => {
    fcAssert(
      property(messyInputArb, (input) => {
        expect(slugify(input).includes("--")).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent: slugify(slugify(x)) === slugify(x)", () => {
    fcAssert(
      property(messyInputArb, (input) => {
        const once = slugify(input);
        const twice = slugify(once);
        expect(twice).toBe(once);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("any arbitrary string still produces a valid slug", () => {
    // Broader coverage with the unconstrained string arbitrary — catches
    // anything the curated charset above might miss.
    fcAssert(
      property(string(), (input) => {
        expect(slugify(input)).toMatch(VALID_SLUG_RE);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("path/scope separators always become hyphens between alnum runs", () => {
    // For inputs of the form "<a>/<b>" or "<a>\<b>" where both halves contain
    // valid slug chars, the separator must produce a hyphen in the output —
    // never a silent mash-up like "<a><b>".
    const segmentChars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const segmentArb = array(constantFrom(...segmentChars.split("")), {
      minLength: 1,
      maxLength: 10,
    }).map((chars) => chars.join(""));

    fcAssert(
      property(segmentArb, segmentArb, constantFrom("/", "\\"), (a, b, sep) => {
        expect(slugify(`${a}${sep}${b}`)).toBe(`${a}-${b}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
