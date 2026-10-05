/**
 * Byte-level helpers for building wasm fixtures.
 *
 * These deliberately assemble modules by hand rather than through
 * `src/lib/wasm/binary.ts`, so a bug in the encoder cannot hide behind a
 * fixture built with the same bug.
 */

/** Magic bytes and version that open every WebAssembly module. */
export const WASM_HEADER = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

/**
 * Section id of the Code section.
 *
 * DWARF offsets are relative to it, so a debug companion that drops the code
 * section cannot be symbolicated. That is what the companion fixtures assert.
 */
export const CODE_SECTION_ID = 10;

/**
 * Section id of the Data count section.
 *
 * Numbered after the code section but required to precede it, which is why the
 * section order cannot be checked by comparing ids.
 */
export const DATA_COUNT_SECTION_ID = 12;

/** Parse a hex string into bytes. */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Render bytes as lowercase hex. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Join byte ranges into one buffer. */
export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Encode an unsigned LEB128 integer, optionally padded.
 *
 * Padding produces a non-canonical but legal encoding, which some toolchains
 * emit and which a faithful round-trip must preserve.
 */
// biome-ignore-start lint/suspicious/noBitwiseOperators: LEB128 is defined in terms of bit groups
export function leb128(value: number, padTo = 0): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.push(remaining & 0x7f);
    remaining >>>= 7;
  } while (remaining !== 0);
  // Padding appends zero groups, which only a continuation flag makes legal.
  while (bytes.length < padTo) {
    bytes.push(0x00);
  }
  for (let index = 0; index < bytes.length - 1; index++) {
    bytes[index] = (bytes[index] as number) | 0x80;
  }
  return Uint8Array.from(bytes);
}
// biome-ignore-end lint/suspicious/noBitwiseOperators: LEB128 is defined in terms of bit groups

/** Encode one section: id, length prefix, payload. */
export function section(
  id: number,
  payload: Uint8Array,
  padLengthTo = 0
): Uint8Array {
  return concat([
    Uint8Array.from([id]),
    leb128(payload.length, padLengthTo),
    payload,
  ]);
}

/** Encode a custom section: id 0, then a length-prefixed name and a body. */
export function customSection(
  name: string,
  contents: Uint8Array,
  padLengthTo = 0
): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  return section(
    0,
    concat([leb128(nameBytes.length), nameBytes, contents]),
    padLengthTo
  );
}

/** Wrap sections in a module header. */
export function wasmModule(sections: Uint8Array[]): Uint8Array {
  return concat([WASM_HEADER, ...sections]);
}

/** Prefix bytes with their length, as a `Vec<u8>` or `String` body. */
export function byteVector(bytes: Uint8Array): Uint8Array {
  return concat([leb128(bytes.length), bytes]);
}

/**
 * Read a length-prefixed UTF-8 string, as an `external_debug_info` body holds.
 *
 * Decoded here rather than through `src/lib/wasm/binary.ts` for the same reason
 * the fixtures are built here: a bug in the encoder must not be able to hide
 * behind a decoder that shares it.
 *
 * @returns The string, or `null` when the prefix disagrees with the body or the
 *   bytes are not valid UTF-8
 */
// biome-ignore-start lint/suspicious/noBitwiseOperators: LEB128 is defined in terms of bit groups
export function readByteVectorString(contents: Uint8Array): string | null {
  let length = 0;
  let scale = 1;
  let offset = 0;
  for (;;) {
    const byte = contents[offset];
    if (byte === undefined) {
      return null;
    }
    offset += 1;
    length += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) {
      break;
    }
    scale *= 128;
  }
  if (offset + length !== contents.length) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      contents.subarray(offset, offset + length)
    );
  } catch {
    // Invalid UTF-8 is an expected fixture, not a failure worth reporting.
    return null;
  }
}
// biome-ignore-end lint/suspicious/noBitwiseOperators: LEB128 is defined in terms of bit groups
