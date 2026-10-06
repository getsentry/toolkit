/** Invariants for opaque bearer credentials and removable edge padding. */

import {
  array,
  constantFrom,
  assert as fcAssert,
  integer,
  property,
} from "fast-check";
import { describe, expect, test } from "vitest";
import {
  formatAuthHeader,
  normalizeAuthToken,
  trimAuthToken,
} from "../../src/lib/auth-header.js";
import { MalformedAuthTokenError } from "../../src/lib/errors.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

const printable = array(integer({ min: 0x21, max: 0x7e }), {
  minLength: 1,
  maxLength: 80,
}).map((codes) => String.fromCharCode(...codes));
const paddingCharacter = constantFrom(
  ...Array.from({ length: 33 }, (_, code) => String.fromCharCode(code)),
  "\x7f",
  "\u00a0",
  "\ufeff"
);
const padding = array(paddingCharacter, { maxLength: 20 }).map((chars) =>
  chars.join("")
);

describe("auth token normalization", () => {
  test("preserves every printable credential regardless of surrounding padding", () => {
    fcAssert(
      property(printable, padding, padding, (token, before, after) => {
        const input = before + token + after;
        expect(trimAuthToken(input)).toBe(token);
        expect(normalizeAuthToken(input)).toBe(token);
        expect(normalizeAuthToken(normalizeAuthToken(input))).toBe(token);
        expect(formatAuthHeader(input)).toBe(`Bearer ${token}`);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("rejects padding inside a credential without removing it", () => {
    fcAssert(
      property(
        printable,
        paddingCharacter,
        printable,
        (before, char, after) => {
          const input = before + char + after;
          expect(trimAuthToken(input)).toBe(input);
          expect(() => normalizeAuthToken(input)).toThrow(
            MalformedAuthTokenError
          );
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("rejects empty or padding-only credentials", () => {
    fcAssert(
      property(padding, (input) => {
        expect(() => normalizeAuthToken(input)).toThrow(
          MalformedAuthTokenError
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test.each([
    "\x80",
    "\x85",
    "\u200b",
    "é",
    "💥",
  ])("does not silently remove other Unicode characters %#", (char) => {
    expect(() => normalizeAuthToken(`${char}token`)).toThrow(
      MalformedAuthTokenError
    );
    expect(() => normalizeAuthToken(`token${char}`)).toThrow(
      MalformedAuthTokenError
    );
  });
});
