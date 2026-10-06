/**
 * Tests for the `build_id` custom section.
 */

import { describe, expect, test } from "vitest";
import { parseSections } from "../../../src/lib/wasm/binary.js";
import {
  buildIdFromSections,
  formatBuildId,
  randomBuildId,
  uuidToBytes,
} from "../../../src/lib/wasm/build-id.js";
import {
  byteVector,
  CODE_SECTION_ID,
  customSection,
  fromHex,
  section,
  toHex,
  WASM_HEADER,
  wasmModule,
} from "./helpers.js";

/** A module carrying the given build id. */
function moduleWithBuildId(buildId: Uint8Array): Uint8Array {
  return wasmModule([
    section(CODE_SECTION_ID, fromHex("01020304")),
    customSection("build_id", byteVector(buildId)),
  ]);
}

describe("uuidToBytes", () => {
  test.each([
    ["canonical", "a1b2c3d4-e5f6-4788-99aa-bbccddeeff00"],
    ["unhyphenated and uppercase", "A1B2C3D4E5F6478899AABBCCDDEEFF00"],
  ])("parses a %s UUID", (_label, uuid) => {
    expect(toHex(uuidToBytes(uuid) as Uint8Array)).toBe(
      "a1b2c3d4e5f6478899aabbccddeeff00"
    );
  });

  test.each([
    ["too short", "a1b2c3d4"],
    ["not hex", "a1b2c3d4-e5f6-4788-99aa-bbccddeeffzz"],
    ["empty", ""],
  ])("rejects a %s value", (_label, value) => {
    expect(uuidToBytes(value)).toBeNull();
  });
});

describe("formatBuildId", () => {
  test("prints an id that is not a UUID, as the Rust tool does", () => {
    expect(formatBuildId(fromHex("0102030405"))).toBe("0102030405");
  });
});

describe("randomBuildId", () => {
  test("mints a distinct v4 UUID each time", () => {
    // Version nibble 4 and variant nibble 8-b, at bytes 6 and 8.
    const first = formatBuildId(randomBuildId());
    expect(first).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    expect(first).not.toBe(formatBuildId(randomBuildId()));
  });
});

describe("buildIdFromSections", () => {
  test("finds the id in a module that has one", () => {
    const buildId = fromHex("000102030405060708090a0b0c0d0e0f");
    const found = buildIdFromSections(
      parseSections(moduleWithBuildId(buildId))
    );
    expect(toHex(found as Uint8Array)).toBe(toHex(buildId));
  });

  test("returns null for a module with no build_id", () => {
    expect(buildIdFromSections(parseSections(WASM_HEADER))).toBeNull();
  });

  test("returns null when the build_id body is malformed", () => {
    const broken = wasmModule([customSection("build_id", fromHex("20ff"))]);
    expect(buildIdFromSections(parseSections(broken))).toBeNull();
  });

  test("takes the first id when a module carries two", () => {
    // The Rust tool's `find_map` stops at the first; a module should never
    // have two, but the tie must break the same way in both tools.
    const duplicated = wasmModule([
      customSection("build_id", byteVector(fromHex("11".repeat(16)))),
      customSection("build_id", byteVector(fromHex("22".repeat(16)))),
    ]);
    expect(
      toHex(buildIdFromSections(parseSections(duplicated)) as Uint8Array)
    ).toBe("11".repeat(16));
  });

  test("skips a malformed section to reach a readable one", () => {
    // Reusing the good id is what keeps already-uploaded debug files matched.
    const mixed = wasmModule([
      customSection("build_id", fromHex("20ff")),
      customSection("build_id", byteVector(fromHex("33".repeat(16)))),
    ]);
    expect(toHex(buildIdFromSections(parseSections(mixed)) as Uint8Array)).toBe(
      "33".repeat(16)
    );
  });

  test("ignores a malformed section that follows a readable one", () => {
    const mixed = wasmModule([
      customSection("build_id", byteVector(fromHex("44".repeat(16)))),
      customSection("build_id", fromHex("20ff")),
    ]);
    expect(toHex(buildIdFromSections(parseSections(mixed)) as Uint8Array)).toBe(
      "44".repeat(16)
    );
  });
});
