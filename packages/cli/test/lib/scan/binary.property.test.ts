/**
 * Property tests for binary classification.
 *
 * We pin the core invariant: `isLikelyBinary(buf)` is equivalent to
 * "the first 8 KB of `buf` contains a 0x00 byte." Everything else in
 * `binary.ts` is derived from that predicate.
 */

import { assert as fcAssert, integer, property, uint8Array } from "fast-check";
import { describe, expect, test } from "vitest";
import { isLikelyBinary } from "../../../src/lib/scan/binary.js";
import { BINARY_SNIFF_BYTES } from "../../../src/lib/scan/constants.js";
import { DEFAULT_NUM_RUNS } from "../../model-based/helpers.js";

/** Reference implementation: scan the first `BINARY_SNIFF_BYTES` for NUL. */
function referenceHasNul(buf: Uint8Array): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i += 1) {
    if (buf[i] === 0) {
      return true;
    }
  }
  return false;
}

describe("property: isLikelyBinary", () => {
  test("matches reference impl on random buffers", () => {
    fcAssert(
      property(uint8Array({ minLength: 0, maxLength: 9000 }), (buf) => {
        expect(isLikelyBinary(buf)).toBe(referenceHasNul(buf));
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("idempotent: repeated calls produce the same answer", () => {
    fcAssert(
      property(uint8Array({ minLength: 0, maxLength: 2048 }), (buf) => {
        const a = isLikelyBinary(buf);
        const b = isLikelyBinary(buf);
        expect(a).toBe(b);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("inserting a NUL inside the sniff window forces binary", () => {
    fcAssert(
      property(
        uint8Array({ minLength: 1, maxLength: BINARY_SNIFF_BYTES }),
        integer({ min: 0 }),
        (buf, offsetSeed) => {
          const buf2 = new Uint8Array(buf);
          const idx = offsetSeed % buf2.length;
          buf2[idx] = 0;
          expect(isLikelyBinary(buf2)).toBe(true);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("buffers of NUL-free bytes inside the window classify as text", () => {
    fcAssert(
      property(
        uint8Array({ minLength: 0, maxLength: BINARY_SNIFF_BYTES }),
        (buf) => {
          // Strip NULs by flipping each to 1.
          const clean = buf.map((b) => (b === 0 ? 1 : b));
          expect(isLikelyBinary(clean)).toBe(false);
        }
      ),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
