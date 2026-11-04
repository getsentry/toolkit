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
  encodeAuthTokenForEnv,
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
  "\ufeff",
);
const padding = array(paddingCharacter, { maxLength: 20 }).map((chars) =>
  chars.join(""),
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
      { numRuns: DEFAULT_NUM_RUNS },
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
            MalformedAuthTokenError,
          );
        },
      ),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("rejects empty or padding-only credentials", () => {
    fcAssert(
      property(padding, (input) => {
        expect(() => normalizeAuthToken(input)).toThrow(
          MalformedAuthTokenError,
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test.each(["\x80", "\x85", "\u200b", "é", "💥"])(
    "does not silently remove other Unicode characters %#",
    (char) => {
      expect(() => normalizeAuthToken(`${char}token`)).toThrow(
        MalformedAuthTokenError,
      );
      expect(() => normalizeAuthToken(`token${char}`)).toThrow(
        MalformedAuthTokenError,
      );
    },
  );
});

/** Token-shaped input mixing printable, padding, NUL, and other bytes. */
const envTokenInput = array(
  constantFrom(
    "a",
    "Z",
    "0",
    "-",
    "_",
    " ",
    "\t",
    "\n",
    "\x00",
    "\x7f",
    "\x01",
    "é",
  ),
  { maxLength: 60 },
).map((chars) => chars.join(""));

/** Shared validator result: the normalized credential or null when rejected. */
function normalizeOrNull(input: string): string | null {
  try {
    return normalizeAuthToken(input);
  } catch (error) {
    if (error instanceof MalformedAuthTokenError) {
      return null;
    }
    throw error;
  }
}

describe("env-storage encoding", () => {
  test("never emits a byte env storage would truncate on", () => {
    fcAssert(
      property(envTokenInput, (input) => {
        expect(encodeAuthTokenForEnv(input)).not.toContain("\x00");
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("preserves the shared normalization outcome for any input", () => {
    fcAssert(
      property(envTokenInput, (input) => {
        const encoded = encodeAuthTokenForEnv(input);
        // Edge padding trims identically: NUL and DEL occupy the same
        // padding class, so the trimmed lengths always match — including
        // both-empty (padding-only) cases.
        expect(trimAuthToken(encoded).length).toBe(trimAuthToken(input).length);
        // Validity is preserved exactly: the validator accepts the encoded
        // form iff it accepts the raw form, with the same normalized result.
        expect(normalizeOrNull(encoded)).toBe(normalizeOrNull(input));
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });
});
