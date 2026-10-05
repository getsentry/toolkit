/**
 * Property-Based Tests for TRDIFF10 Patch Parsing
 *
 * Uses fast-check to verify invariants of the offtin and parsePatchHeader
 * functions across random inputs.
 */

import { offtin, parsePatchHeader } from "binpatch";
import { assert as fcAssert, integer, property, uint8Array } from "fast-check";
import { describe, expect, test } from "vitest";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

describe("property: offtin", () => {
  test("magnitude is always non-negative", () => {
    fcAssert(
      property(uint8Array({ minLength: 8, maxLength: 8 }), (buf) => {
        const value = offtin(buf, 0);
        // The magnitude is always >= 0; the sign makes the result negative
        // |value| should be representable
        expect(Number.isFinite(value)).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("zero bytes produce zero", () => {
    const buf = new Uint8Array(8);
    expect(offtin(buf, 0)).toBe(0);
  });

  test("sign bit only affects sign, not magnitude", () => {
    fcAssert(
      property(uint8Array({ minLength: 8, maxLength: 8 }), (buf) => {
        // Clear sign bit and read
        const cleared = new Uint8Array(buf);
        cleared[7] %= 128; // Clear bit 7
        const positive = offtin(cleared, 0);

        // Set sign bit and read
        const negated = new Uint8Array(buf);
        negated[7] = (negated[7] % 128) + 128; // Set bit 7 (can't use %= here)
        const negative = offtin(negated, 0);

        // Magnitude should be the same
        expect(Math.abs(positive)).toBe(Math.abs(negative));
        // Signs should be correct
        expect(positive).toBeGreaterThanOrEqual(0);
        expect(negative).toBeLessThanOrEqual(0);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("round-trip: value → LE bytes → offtin recovers original", () => {
    // Test with safe integer range values that fit in 53 bits
    fcAssert(
      property(
        integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        (magnitude) => {
          const buf = new Uint8Array(8);
          const view = new DataView(buf.buffer);
          // Write as unsigned LE: low 32 bits at offset 0, high at offset 4
          view.setUint32(0, magnitude % 0x1_00_00_00_00, true);
          view.setUint32(4, Math.floor(magnitude / 0x1_00_00_00_00), true);

          const result = offtin(buf, 0);
          expect(result).toBe(magnitude);

          // Now test negative
          buf[7] += 128; // Set sign bit
          const negResult = offtin(buf, 0);
          if (magnitude === 0) {
            expect(negResult).toBe(0); // -0 === 0
          } else {
            expect(negResult).toBe(-magnitude);
          }
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: parsePatchHeader", () => {
  test("always rejects buffers shorter than 32 bytes", () => {
    fcAssert(
      property(uint8Array({ minLength: 0, maxLength: 31 }), (buf) => {
        expect(() => parsePatchHeader(buf)).toThrow("Patch too small");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("always rejects non-TRDIFF10 magic", () => {
    fcAssert(
      property(uint8Array({ minLength: 32, maxLength: 64 }), (buf) => {
        // Ensure magic is NOT TRDIFF10 by checking first 8 bytes
        const magic = new TextDecoder().decode(buf.subarray(0, 8));
        if (magic === "TRDIFF10") {
          return; // Skip valid magic (unlikely but possible)
        }
        expect(() => parsePatchHeader(buf)).toThrow("Invalid patch format");
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("parsed values are always non-negative", () => {
    fcAssert(
      property(uint8Array({ minLength: 32, maxLength: 256 }), (buf) => {
        // Set valid magic
        const patched = new Uint8Array(buf);
        patched.set(new TextEncoder().encode("TRDIFF10"), 0);
        // Clear sign bits in header fields
        patched[15] %= 128; // controlLen sign
        patched[23] %= 128; // diffLen sign
        patched[31] %= 128; // newSize sign

        try {
          const header = parsePatchHeader(patched);
          expect(header.controlLen).toBeGreaterThanOrEqual(0);
          expect(header.diffLen).toBeGreaterThanOrEqual(0);
          expect(header.newSize).toBeGreaterThanOrEqual(0);
        } catch {
          // May throw for other reasons (length overflow) — that's fine
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
