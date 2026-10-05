/**
 * CRC-32 checksum that works on every Node.js version the npm package runs on.
 *
 * `zlib.crc32` only exists on Node.js >= 20.15 / >= 22.2, but the npm package
 * accepts Node.js 18+ (see the version gate in `script/bundle.ts`). Older
 * runtimes fall back to a table-driven implementation of the same IEEE 802.3
 * polynomial, so the checksums are identical either way.
 */

import zlib from "node:zlib";

/** Reflected CRC-32 (IEEE 802.3) polynomial. */
const POLYNOMIAL = 0xed_b8_83_20;

let table: Uint32Array | undefined;

// biome-ignore-start lint/suspicious/noBitwiseOperators: CRC-32 is defined in terms of bitwise operations
function getTable(): Uint32Array {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? POLYNOMIAL ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
  }
  return table;
}

/**
 * Portable CRC-32, used when `zlib.crc32` is unavailable.
 *
 * @internal Exported for testing
 */
export function crc32Fallback(data: Uint8Array, value = 0): number {
  const lookup = getTable();
  let crc = ~value;
  for (const byte of data) {
    crc = (lookup[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return ~crc >>> 0;
}
// biome-ignore-end lint/suspicious/noBitwiseOperators: CRC-32 is defined in terms of bitwise operations

/**
 * Compute the CRC-32 of `data`, optionally continuing from a previous
 * checksum `value`. Returns an unsigned 32-bit integer, like `zlib.crc32`.
 */
export const crc32: (data: Uint8Array, value?: number) => number =
  typeof zlib.crc32 === "function" ? zlib.crc32 : crc32Fallback;
