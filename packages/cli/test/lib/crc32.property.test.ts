/**
 * Property-Based Tests for the portable CRC-32 fallback.
 *
 * The fallback must be byte-for-byte compatible with `zlib.crc32` (the
 * native implementation on Node.js >= 20.15 / >= 22.2), including when a
 * checksum is continued across chunks.
 */

import { crc32 as nativeCrc32 } from "node:zlib";
import { assert as fcAssert, property, uint8Array } from "fast-check";
import { describe, expect, test } from "vitest";
import { crc32Fallback } from "../../src/lib/crc32.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

describe("property: crc32Fallback", () => {
  test("matches zlib.crc32 for arbitrary bytes", () => {
    fcAssert(
      property(uint8Array({ maxLength: 4096 }), (data) => {
        expect(crc32Fallback(data)).toBe(nativeCrc32(data));
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("continuing from a previous checksum equals hashing the concatenation", () => {
    fcAssert(
      property(uint8Array(), uint8Array(), (a, b) => {
        const joined = Buffer.concat([a, b]);
        expect(crc32Fallback(b, crc32Fallback(a))).toBe(crc32Fallback(joined));
        expect(crc32Fallback(b, nativeCrc32(a))).toBe(nativeCrc32(joined));
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("produces the standard CRC-32 check value", () => {
    expect(crc32Fallback(Buffer.from("123456789"))).toBe(0xcb_f4_39_26);
  });
});
