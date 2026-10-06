/**
 * Property-based tests for hex ID recovery helpers.
 *
 * Focus on invariants that must hold for *any* valid input:
 * - `stripTrailingNonHex` always returns hex of the expected length or null
 * - `extractHexCandidate` output is always lowercase hex or undefined
 * - Valid full-length hex IDs never trigger recovery (`validateHexId` accepts them)
 */

import {
  array,
  constantFrom,
  assert as fcAssert,
  integer,
  property,
  string,
  tuple,
} from "fast-check";
import { describe, test } from "vitest";

import {
  ageInDaysFromUuidV7,
  decodeUuidV7Timestamp,
  validateHexId,
} from "../../src/lib/hex-id.js";
import {
  extractHexCandidate,
  isOverNestedPath,
  looksLikeSlug,
  preNormalize,
  stripTrailingNonHex,
} from "../../src/lib/hex-id-recovery.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

const HEX_CHARS = "0123456789abcdef".split("");
const NON_HEX_CHARS = "ghijklmnopqrstuvwxyz!@#$%^&*()_+=".split("");

/** Generate a 32-char hex string */
const hex32Arb = array(constantFrom(...HEX_CHARS), {
  minLength: 32,
  maxLength: 32,
}).map((chars) => chars.join(""));

/** Generate a 16-char hex string */
const hex16Arb = array(constantFrom(...HEX_CHARS), {
  minLength: 16,
  maxLength: 16,
}).map((chars) => chars.join(""));

/** Generate a non-empty string of non-hex chars */
const nonHexSuffixArb = array(constantFrom(...NON_HEX_CHARS), {
  minLength: 1,
  maxLength: 10,
}).map((chars) => chars.join(""));

/** Generate a hex prefix of variable length (1..31 chars) */
const shortHexArb = array(constantFrom(...HEX_CHARS), {
  minLength: 1,
  maxLength: 31,
}).map((chars) => chars.join(""));

describe("property: stripTrailingNonHex", () => {
  test("<32hex> + non-hex junk → strips cleanly to 32hex", () => {
    fcAssert(
      property(hex32Arb, nonHexSuffixArb, (hex, junk) => {
        const input = `${hex}${junk}`;
        const result = stripTrailingNonHex(input, 32);
        if (!result) {
          throw new Error(`Expected non-null for ${input}`);
        }
        if (result.hex !== hex) {
          throw new Error(`Expected ${hex}, got ${result.hex}`);
        }
        if (result.stripped !== junk) {
          throw new Error(`Expected stripped=${junk}, got ${result.stripped}`);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("<32hex> alone (no junk) → returns null", () => {
    fcAssert(
      property(hex32Arb, (hex) => {
        if (stripTrailingNonHex(hex, 32) !== null) {
          throw new Error(`Expected null for exact-length input ${hex}`);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("short hex + anything → returns null (falls through to fuzzy)", () => {
    fcAssert(
      property(shortHexArb, string(), (hex, anything) => {
        const input = `${hex}${anything}`;
        // Only interesting when input length > 32 (precondition for the
        // strip function to consider it). Skip otherwise.
        if (input.length <= 32) {
          return;
        }
        const result = stripTrailingNonHex(input, 32);
        // If null → good.
        // If non-null → the "hex" must be exactly 32 chars AND match the input prefix.
        if (result) {
          if (result.hex.length !== 32) {
            throw new Error(
              `hex result length ${result.hex.length} !== 32 for input ${input}`
            );
          }
          if (!input.startsWith(result.hex)) {
            throw new Error(
              `input ${input} does not start with returned hex ${result.hex}`
            );
          }
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("span length: <16hex> + junk → strips to 16hex", () => {
    fcAssert(
      property(hex16Arb, nonHexSuffixArb, (hex, junk) => {
        const result = stripTrailingNonHex(`${hex}${junk}`, 16);
        if (!result || result.hex !== hex || result.stripped !== junk) {
          throw new Error(`Unexpected result for ${hex}${junk}`);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: extractHexCandidate", () => {
  test("output prefix is always lowercase hex (no non-hex chars)", () => {
    fcAssert(
      property(string(), (input) => {
        const result = extractHexCandidate(input);
        if (!result) {
          return;
        }
        if (result.prefix && !/^[0-9a-f]*$/.test(result.prefix)) {
          throw new Error(
            `prefix '${result.prefix}' contains non-hex chars (input: ${input})`
          );
        }
        if (result.suffix && !/^[0-9a-f]*$/.test(result.suffix)) {
          throw new Error(`suffix '${result.suffix}' contains non-hex chars`);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("plain hex prefix round-trip: candidate.prefix === input.match(/^[0-9a-f]+/)", () => {
    fcAssert(
      property(tuple(shortHexArb, nonHexSuffixArb), ([hex, suffix]) => {
        const result = extractHexCandidate(`${hex}${suffix}`);
        if (!result || result.prefix !== hex) {
          throw new Error(`Expected prefix ${hex}, got ${result?.prefix}`);
        }
        if (result.suffix !== undefined) {
          throw new Error(`Unexpected suffix ${result.suffix}`);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: valid hex IDs never need recovery", () => {
  test("valid 32-hex passes validateHexId unchanged", () => {
    fcAssert(
      property(hex32Arb, (hex) => {
        // validateHexId returns the normalized ID; must match (already lowercase).
        const result = validateHexId(hex, "test ID");
        if (result !== hex) {
          throw new Error(`Expected ${hex}, got ${result}`);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: preNormalize", () => {
  test("output length <= input length (never grows)", () => {
    fcAssert(
      property(string(), (input) => {
        const { cleaned } = preNormalize(input);
        if (cleaned.length > input.length) {
          throw new Error(
            `Output grew: input=${input.length}, output=${cleaned.length}`
          );
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent — preNormalize of preNormalize yields same cleaned value", () => {
    fcAssert(
      property(string(), (input) => {
        const once = preNormalize(input).cleaned;
        const twice = preNormalize(once).cleaned;
        if (once !== twice) {
          throw new Error(`Not idempotent: ${once} !== ${twice}`);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: looksLikeSlug vs extractHexCandidate", () => {
  test("any pure long-hex input is never classified as slug", () => {
    fcAssert(
      property(hex32Arb, (hex) => {
        if (looksLikeSlug(hex)) {
          throw new Error(`Pure hex ${hex} classified as slug`);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: UUIDv7 round-trip via decode/age", () => {
  /** Build a 32-char UUIDv7 where the embedded timestamp is `ms`. */
  function buildUuidV7(ms: number): string {
    const ts = ms.toString(16).padStart(12, "0");
    return `${ts}70008000000000000000`;
  }

  // UUIDv7 was standardized May 2024 (RFC 9562). Restrict the arbitrary
  // to plausible real timestamps: Jan 2024 through year 3000 (48-bit
  // ceiling is 10889 so pre-3000 is well within range).
  // 2024-01-01 ≈ 1.704e12, 3000-01-01 ≈ 3.25e13.
  const msArb = integer({ min: 1_704_067_200_000, max: 32_503_680_000_000 });

  test("decoded timestamp round-trips the original ms", () => {
    fcAssert(
      property(msArb, (ms) => {
        const decoded = decodeUuidV7Timestamp(buildUuidV7(ms));
        if (!decoded) {
          throw new Error(`Failed to decode UUIDv7 for ms=${ms}`);
        }
        if (decoded.createdAt.getTime() !== ms) {
          throw new Error(
            `Round-trip failed: ${ms} → ${decoded.createdAt.getTime()}`
          );
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("age is monotonic: older UUIDv7 ⇒ age >= newer UUIDv7", () => {
    fcAssert(
      property(msArb, msArb, (msA, msB) => {
        const now = new Date(Math.max(msA, msB) + 24 * 60 * 60 * 1000);
        const ageA = ageInDaysFromUuidV7(buildUuidV7(msA), now);
        const ageB = ageInDaysFromUuidV7(buildUuidV7(msB), now);
        if (ageA === null || ageB === null) {
          throw new Error("Unexpected null");
        }
        // Older ms → larger age (more days before `now`).
        if (msA < msB && ageA < ageB) {
          throw new Error(
            `Monotonicity broken: ${msA}<${msB} but ${ageA}<${ageB}`
          );
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: isOverNestedPath", () => {
  test("returns true iff there are 4+ slash-separated non-empty segments", () => {
    fcAssert(
      property(
        array(constantFrom("a", "b", "c", "1", "2"), {
          minLength: 1,
          maxLength: 6,
        }),
        (segments) => {
          const input = segments.join("/");
          const expected = segments.length >= 4;
          if (isOverNestedPath(input) !== expected) {
            throw new Error(
              `isOverNestedPath(${input}) expected ${expected}, got ${!expected}`
            );
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
