/**
 * Reading and writing the WebAssembly binary envelope.
 *
 * Only the module envelope is modelled: the 8-byte header followed by a flat,
 * ordered list of sections. Section payloads stay opaque byte ranges, because
 * every tool in this area needs to add or drop a custom section while leaving
 * code, data, and anything this parser has never heard of exactly as it found
 * them.
 *
 * Payloads being opaque does not make the envelope unchecked. Validation goes
 * exactly as deep as `wasmbin`, the parser behind the Rust `wasm-split`, and no
 * deeper: `wasmbin` reads each section as a lazy length-prefixed blob, so it
 * accepts a module whose code section is nonsense, and rejects one whose
 * envelope is wrong — a section id the spec does not define, or sections out of
 * the mandated order. `WebAssembly.validate` is not a substitute. It also
 * type-checks function bodies, and so rejects files the Rust tool accepts.
 *
 * Round-trip fidelity is a hard requirement, not a convenience. A module whose
 * sections are parsed and re-encoded unchanged must come out byte-identical, so
 * each parsed section keeps a view of its original bytes and is emitted
 * verbatim. That covers section kinds this parser does not recognise, and also
 * non-canonical LEB128 lengths, which some toolchains pad. `wasm-split` once
 * shipped a bug in this exact area (symbolicator#311, "wasm-split now retains
 * all sections"), and stripping a section a user did not ask to lose is silent
 * until symbolication fails.
 *
 * Custom section bodies follow `wasmbin`'s encoding, so files written here are
 * interchangeable with those written by the Rust `wasm-split`.
 */

import { logger } from "../logger.js";

const log = logger.withTag("wasm.binary");

/** Section id of a custom section. */
const CUSTOM_SECTION_ID = 0;

/** Name of the custom section holding function names. */
const NAME_SECTION = "name";

/** Name of the custom section holding a module's build id. */
export const BUILD_ID_SECTION = "build_id";

/** Name of the custom section pointing at a module's debug companion. */
const EXTERNAL_DEBUG_INFO_SECTION = "external_debug_info";

/** Prefix shared by the custom sections that carry DWARF. */
const DEBUG_SECTION_PREFIX = ".debug_";

/**
 * Non-custom section ids, in the order the spec mandates they appear.
 *
 * Deliberately not sorted by id. The data count section (12) was numbered after
 * the code section (10) but has to precede it, and the exception tag section
 * (13) belongs between memory and global. `wasmbin` spells the same sequence as
 * the declaration order of its section enum, and the Rust `wasm-split` builds it
 * with the `exception-handling` feature on, which is what makes 13 legal here.
 */
const SECTION_ORDER = [
  [1, "type"],
  [2, "import"],
  [3, "function"],
  [4, "table"],
  [5, "memory"],
  [13, "exception tag"],
  [6, "global"],
  [7, "export"],
  [8, "start"],
  [9, "element"],
  [12, "data count"],
  [10, "code"],
  [11, "data"],
] as const;

/** What a non-custom section id means, and where it sorts. */
type SectionKind = {
  /** Human-readable name, for error messages. */
  name: string;
  /** Position in {@link SECTION_ORDER}. */
  rank: number;
};

/** {@link SECTION_ORDER} keyed by section id. */
const SECTION_KINDS = new Map<number, SectionKind>(
  SECTION_ORDER.map(([id, name], rank) => [id, { name, rank }])
);

/** Magic bytes and version that open every WebAssembly module. */
const WASM_HEADER = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
]);

/** Bytes consumed by {@link WASM_HEADER}. */
const WASM_HEADER_LENGTH = WASM_HEADER.length;

/** Continuation flag of a LEB128 group: another byte follows. */
const CONTINUATION_BIT = 0x80;

/** Value bits of a LEB128 group. */
const PAYLOAD_MASK = 0x7f;

/** Distinct values a LEB128 group can hold. */
const GROUP_SIZE = 128;

/** Groups needed to hold a 32-bit value, and so the most we will read. */
const MAX_VARUINT32_BYTES = 5;

/** Largest value a varuint32 may decode to. */
const MAX_UINT32 = 0xff_ff_ff_ff;

/** Raised when a byte stream is not a WebAssembly module this parser can read. */
export class WasmParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WasmParseError";
  }
}

/**
 * One section of a module, as found on disk or as constructed for writing.
 *
 * `name` and `contents` are set only for custom sections whose header could be
 * read; a custom section with a malformed name is still carried, just without
 * them, so one bad section never costs the caller the rest of the file.
 */
export type WasmSection = {
  /** Section id. {@link CUSTOM_SECTION_ID} for custom sections. */
  id: number;
  /** Name of a custom section, absent when unnamed or unreadable. */
  name?: string;
  /** Bytes of a custom section after its name. */
  contents?: Uint8Array;
  /** The section's full payload, excluding its id and length prefix. */
  payload: Uint8Array;
  /**
   * The section exactly as it appeared on disk, including id and length
   * prefix. Present only for parsed sections, and emitted verbatim by
   * {@link encodeModule} so an untouched section round-trips byte-for-byte.
   */
  raw?: Uint8Array;
};

/** A varuint32 read off a byte stream. */
export type VarUint32 = {
  /** The decoded value. */
  value: number;
  /** Bytes the encoding occupied. */
  size: number;
};

// biome-ignore-start lint/suspicious/noBitwiseOperators: LEB128 is defined in terms of bit groups
/**
 * Read an unsigned LEB128 32-bit integer.
 *
 * @param bytes - Buffer to read from
 * @param offset - Index of the first byte of the encoding
 * @returns The value and the number of bytes it occupied
 * @throws {WasmParseError} when the encoding runs past the buffer, spans more
 *   groups than a 32-bit value can need, or decodes above 2^32 - 1
 */
export function readVarUint32(bytes: Uint8Array, offset: number): VarUint32 {
  let value = 0;
  let scale = 1;
  for (let size = 0; size < MAX_VARUINT32_BYTES; size++) {
    const byte = bytes[offset + size];
    if (byte === undefined) {
      throw new WasmParseError(
        `truncated LEB128 integer at offset ${offset + size}`
      );
    }
    // Arithmetic rather than `<<`: a 5th group shifted by 28 would overflow
    // into the sign bit of a 32-bit bitwise operand.
    value += (byte & PAYLOAD_MASK) * scale;
    if ((byte & CONTINUATION_BIT) === 0) {
      if (value > MAX_UINT32) {
        throw new WasmParseError(
          `LEB128 integer at offset ${offset} exceeds 32 bits`
        );
      }
      return { value, size: size + 1 };
    }
    scale *= GROUP_SIZE;
  }
  throw new WasmParseError(
    `LEB128 integer at offset ${offset} is longer than ${MAX_VARUINT32_BYTES} bytes`
  );
}

/**
 * Encode an unsigned LEB128 32-bit integer, canonically.
 *
 * @param value - A non-negative integer below 2^32
 * @returns The encoded bytes, one to five of them
 */
export function writeVarUint32(value: number): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const group = remaining % GROUP_SIZE;
    remaining = Math.floor(remaining / GROUP_SIZE);
    bytes.push(remaining === 0 ? group : group | CONTINUATION_BIT);
  } while (remaining !== 0);
  return Uint8Array.from(bytes);
}
// biome-ignore-end lint/suspicious/noBitwiseOperators: LEB128 is defined in terms of bit groups

/**
 * Split a module into its sections, in file order.
 *
 * Every section keeps a view of its original bytes, so passing the result
 * straight to {@link encodeModule} reproduces the input exactly.
 *
 * @param bytes - A complete WebAssembly module
 * @returns The module's sections, in the order they appear
 * @throws {WasmParseError} when the header is wrong, a section runs past the end
 *   of the buffer, a section id is not one the spec defines, or the sections are
 *   out of the mandated order
 */
export function parseSections(bytes: Uint8Array): WasmSection[] {
  assertWasmHeader(bytes);
  const sections: WasmSection[] = [];
  let offset = WASM_HEADER_LENGTH;
  let lastRank = -1;
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset] as number;
    offset += 1;
    // Id first, then length, then position: the order `wasmbin` reports these
    // in, so a module wrong in two ways gets the same complaint from both tools.
    const kind = sectionKind(id, start);
    const { value: payloadLength, size } = readVarUint32(bytes, offset);
    offset += size;
    const payloadEnd = offset + payloadLength;
    if (payloadEnd > bytes.length) {
      throw new WasmParseError(
        `section at offset ${start} claims ${payloadLength} bytes but only ${bytes.length - offset} remain`
      );
    }
    lastRank = checkSectionOrder(kind, lastRank, start);
    const payload = bytes.subarray(offset, payloadEnd);
    sections.push({
      id,
      ...readCustomHeader(id, payload),
      payload,
      raw: bytes.subarray(start, payloadEnd),
    });
    offset = payloadEnd;
  }
  return sections;
}

/**
 * Reassemble sections into a module.
 *
 * Sections carrying their original bytes are written verbatim; sections built
 * by the constructors below are encoded canonically.
 *
 * @param sections - Sections to write, in the order they should appear
 * @returns The complete module
 */
export function encodeModule(sections: WasmSection[]): Uint8Array {
  const parts: Uint8Array[] = [WASM_HEADER];
  for (const section of sections) {
    parts.push(section.raw ?? encodeSection(section));
  }
  return concatBytes(parts);
}

/**
 * Build a custom section from a name and an already-encoded body.
 *
 * @param name - Section name, as it appears in the module
 * @param contents - Everything after the name
 * @returns A section ready to hand to {@link encodeModule}
 */
function makeCustomSection(name: string, contents: Uint8Array): WasmSection {
  const nameBytes = new TextEncoder().encode(name);
  const payload = concatBytes([
    writeVarUint32(nameBytes.length),
    nameBytes,
    contents,
  ]);
  return { id: CUSTOM_SECTION_ID, name, contents, payload };
}

/**
 * Build a `build_id` custom section.
 *
 * The body is a length-prefixed byte vector, matching `wasmbin`'s
 * `CustomSection::BuildId(Vec<u8>)`.
 *
 * @param buildId - Raw build id bytes, conventionally a 16-byte UUID
 */
export function makeBuildIdSection(buildId: Uint8Array): WasmSection {
  return makeCustomSection(BUILD_ID_SECTION, encodeByteVector(buildId));
}

/**
 * Build an `external_debug_info` custom section.
 *
 * The body is a length-prefixed UTF-8 string, matching `wasmbin`'s
 * `CustomSection::ExternalDebugInfo(Lazy<String>)`.
 *
 * @param url - Where the debug companion can be fetched. A bare filename
 *   resolves relative to the module, which is how Emscripten reads it.
 */
export function makeExternalDebugInfoSection(url: string): WasmSection {
  return makeCustomSection(
    EXTERNAL_DEBUG_INFO_SECTION,
    encodeByteVector(new TextEncoder().encode(url))
  );
}

/**
 * Read the bytes out of a `build_id` section body.
 *
 * @param contents - The section body, after its name
 * @returns The build id, or `null` when the body is malformed
 */
export function decodeBuildId(contents: Uint8Array): Uint8Array | null {
  return decodeByteVector(contents, BUILD_ID_SECTION);
}

/** Whether a section is one of the custom sections carrying DWARF. */
export function isDebugSection(section: WasmSection): boolean {
  return (
    section.id === CUSTOM_SECTION_ID &&
    section.name !== undefined &&
    section.name.startsWith(DEBUG_SECTION_PREFIX)
  );
}

/** Whether a section is the custom section holding function names. */
export function isNameSection(section: WasmSection): boolean {
  return section.id === CUSTOM_SECTION_ID && section.name === NAME_SECTION;
}

/** Throw unless `bytes` opens with the WebAssembly magic and version. */
function assertWasmHeader(bytes: Uint8Array): void {
  if (bytes.length < WASM_HEADER_LENGTH) {
    throw new WasmParseError(
      `too short to be a WebAssembly module (${bytes.length} bytes)`
    );
  }
  for (let index = 0; index < WASM_HEADER_LENGTH; index++) {
    if (bytes[index] !== WASM_HEADER[index]) {
      throw new WasmParseError(
        "not a WebAssembly module: bad magic or unsupported version"
      );
    }
  }
}

/**
 * Resolve a section id to its kind, rejecting ids the spec does not define.
 *
 * A custom section has no kind: it may appear anywhere, as often as it likes, so
 * it takes no part in the section order.
 *
 * @returns The kind, or `null` for a custom section
 * @throws {WasmParseError} when no released spec defines the id
 */
function sectionKind(id: number, offset: number): SectionKind | null {
  if (id === CUSTOM_SECTION_ID) {
    return null;
  }
  const kind = SECTION_KINDS.get(id);
  if (kind === undefined) {
    throw new WasmParseError(
      `unknown section id ${id} at offset ${offset}: not a section any released WebAssembly version defines`
    );
  }
  return kind;
}

/**
 * Check where a section sits relative to the one before it.
 *
 * Ranks have to strictly increase, which rejects a section placed before one it
 * should follow and, because equal ranks are refused too, a second copy of a
 * section that may appear only once.
 *
 * @returns The rank to compare the next section against
 * @throws {WasmParseError} when the section is out of order or repeated
 */
function checkSectionOrder(
  kind: SectionKind | null,
  lastRank: number,
  offset: number
): number {
  if (kind === null) {
    return lastRank;
  }
  if (kind.rank <= lastRank) {
    throw new WasmParseError(
      `${kind.name} section at offset ${offset} is out of order or repeated`
    );
  }
  return kind.rank;
}

/**
 * Read a custom section's name and body.
 *
 * Returns nothing for a non-custom section, and nothing for a custom section
 * whose name is truncated or not valid UTF-8 — the section itself is still
 * carried, so a single bad header costs only the ability to address it by name.
 *
 * Skipping rather than rejecting is what the Rust tool does. `wasmbin` decodes a
 * custom section's name only when something asks for it, and `wasm-split` drops
 * that error on the floor, so an unreadable name costs the section its identity
 * and nothing more.
 */
function readCustomHeader(
  id: number,
  payload: Uint8Array
): { name?: string; contents?: Uint8Array } {
  if (id !== CUSTOM_SECTION_ID) {
    return {};
  }
  try {
    const { value: nameLength, size } = readVarUint32(payload, 0);
    const nameEnd = size + nameLength;
    if (nameEnd > payload.length) {
      log.debug("custom section name runs past the section, ignoring name");
      return {};
    }
    return {
      name: new TextDecoder("utf-8", { fatal: true }).decode(
        payload.subarray(size, nameEnd)
      ),
      contents: payload.subarray(nameEnd),
    };
  } catch (error) {
    log.debug("unreadable custom section name, ignoring name", error);
    return {};
  }
}

/** Encode a section body constructed for writing, with its length prefix. */
function encodeSection(section: WasmSection): Uint8Array {
  return concatBytes([
    Uint8Array.from([section.id]),
    writeVarUint32(section.payload.length),
    section.payload,
  ]);
}

/** Prefix bytes with their length, as `wasmbin` encodes `Vec<u8>` and `String`. */
function encodeByteVector(bytes: Uint8Array): Uint8Array {
  return concatBytes([writeVarUint32(bytes.length), bytes]);
}

/**
 * Read a length-prefixed byte vector that spans its whole buffer.
 *
 * The length must account for every remaining byte: a prefix that disagrees
 * with the section it lives in means the body was not written by a tool that
 * agrees with us about the format, and guessing would be worse than declining.
 */
function decodeByteVector(
  contents: Uint8Array,
  sectionName: string
): Uint8Array | null {
  try {
    const { value: length, size } = readVarUint32(contents, 0);
    if (size + length !== contents.length) {
      log.debug(
        `${sectionName} declares ${length} bytes but holds ${contents.length - size}`
      );
      return null;
    }
    return contents.subarray(size, size + length);
  } catch (error) {
    log.debug(`unreadable ${sectionName} body`, error);
    return null;
  }
}

/** Join byte ranges into one buffer. */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
