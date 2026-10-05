/**
 * Tests for the split primitive.
 *
 * These pin the parts of Symbolicator's `wasm-split` that are load-bearing but
 * invisible: the companion is captured before stripping, and an id the module
 * already carries always wins.
 */

import { describe, expect, test } from "vitest";
import {
  parseSections,
  type WasmSection,
} from "../../../src/lib/wasm/binary.js";
import { buildIdFromSections } from "../../../src/lib/wasm/build-id.js";
import { splitWasm } from "../../../src/lib/wasm/split.js";
import {
  byteVector,
  CODE_SECTION_ID,
  customSection,
  fromHex,
  readByteVectorString,
  section,
  toHex,
  wasmModule,
} from "./helpers.js";

/** A module with code, names, and DWARF, but no build id. */
function debugModule(): Uint8Array {
  return wasmModule([
    section(1, fromHex("60000000")),
    section(CODE_SECTION_ID, fromHex("0102030405")),
    customSection("name", fromHex("deadbeef")),
    customSection(".debug_info", fromHex("cafebabe")),
    customSection(".debug_line", fromHex("f00d")),
    customSection("producers", fromHex("2a")),
  ]);
}

/** Names of the custom sections in a module, in order. */
function customNames(bytes: Uint8Array): (string | undefined)[] {
  return parseSections(bytes)
    .filter((entry: WasmSection) => entry.id === 0)
    .map((entry) => entry.name);
}

/** Whether a module still has a code section. */
function hasCodeSection(bytes: Uint8Array): boolean {
  return parseSections(bytes).some((entry) => entry.id === CODE_SECTION_ID);
}

/** Value of the module's `external_debug_info` section, if it has one. */
function externalDebugInfo(bytes: Uint8Array): string | null {
  const found = parseSections(bytes).find(
    (entry) => entry.name === "external_debug_info"
  );
  return found?.contents ? readByteVectorString(found.contents) : null;
}

describe("build id handling", () => {
  test("reuses an id the module already carries", () => {
    const existing = fromHex("000102030405060708090a0b0c0d0e0f");
    const input = wasmModule([
      section(CODE_SECTION_ID, fromHex("01")),
      customSection("build_id", byteVector(existing)),
    ]);

    const result = splitWasm(input, {
      buildId: fromHex("ffffffffffffffffffffffffffffffff"),
    });

    expect(toHex(result.buildId)).toBe(toHex(existing));
    expect(result.moduleChanged).toBe(false);
    expect(toHex(result.module)).toBe(toHex(input));
  });

  test("uses the supplied id when the module has none", () => {
    const supplied = fromHex("0f0e0d0c0b0a09080706050403020100");
    const result = splitWasm(debugModule(), { buildId: supplied });

    expect(toHex(result.buildId)).toBe(toHex(supplied));
    expect(result.moduleChanged).toBe(true);
    expect(
      toHex(buildIdFromSections(parseSections(result.module)) as Uint8Array)
    ).toBe(toHex(supplied));
  });
});

describe("debug companion", () => {
  test("retains every section, including code and DWARF", () => {
    const result = splitWasm(debugModule(), { companion: true, strip: true });
    const companion = result.companion as Uint8Array;

    expect(hasCodeSection(companion)).toBe(true);
    expect(customNames(companion)).toEqual([
      "name",
      ".debug_info",
      ".debug_line",
      "producers",
      "build_id",
    ]);
  });

  test("carries the same build id as the stripped module", () => {
    const result = splitWasm(debugModule(), { companion: true, strip: true });

    expect(
      toHex(
        buildIdFromSections(
          parseSections(result.companion as Uint8Array)
        ) as Uint8Array
      )
    ).toBe(toHex(result.buildId));
    expect(
      toHex(buildIdFromSections(parseSections(result.module)) as Uint8Array)
    ).toBe(toHex(result.buildId));
  });

  test("is absent unless requested", () => {
    expect(splitWasm(debugModule(), { strip: true }).companion).toBeUndefined();
  });
});

describe("stripping", () => {
  test("--strip removes .debug_* and keeps names", () => {
    const result = splitWasm(debugModule(), { strip: true });

    expect(customNames(result.module)).toEqual([
      "name",
      "producers",
      "build_id",
    ]);
    expect(hasCodeSection(result.module)).toBe(true);
  });

  test("--strip --strip-names also removes the name section", () => {
    const result = splitWasm(debugModule(), { strip: true, stripNames: true });

    expect(customNames(result.module)).toEqual(["producers", "build_id"]);
  });

  test("--strip-names is a no-op without --strip", () => {
    const withFlag = splitWasm(debugModule(), {
      stripNames: true,
      buildId: fromHex("00".repeat(16)),
    });
    const without = splitWasm(debugModule(), {
      buildId: fromHex("00".repeat(16)),
    });

    expect(customNames(withFlag.module)).toContain("name");
    expect(toHex(withFlag.module)).toBe(toHex(without.module));
  });

  test("leaves a section whose custom name is unreadable", () => {
    // Name claims 200 bytes inside a 4-byte section, so it is unnamed and
    // cannot be matched against `.debug_` — the same as wasmbin, which skips
    // custom sections whose header will not parse.
    const malformed = section(0, fromHex("c8017f7f"));
    const result = splitWasm(wasmModule([malformed]), { strip: true });

    expect(parseSections(result.module).filter((s) => s.id === 0)).toHaveLength(
      2
    );
  });
});

describe("external_debug_info", () => {
  test("is written when a URL is given", () => {
    const result = splitWasm(debugModule(), {
      externalDebugInfo: "https://cdn.example/app.debug.wasm",
    });

    expect(externalDebugInfo(result.module)).toBe(
      "https://cdn.example/app.debug.wasm"
    );
    expect(result.moduleChanged).toBe(true);
  });

  test("is absent when no URL is given", () => {
    expect(externalDebugInfo(splitWasm(debugModule()).module)).toBeNull();
  });

  test("is not written to the companion", () => {
    const result = splitWasm(debugModule(), {
      companion: true,
      externalDebugInfo: "app.debug.wasm",
    });

    expect(externalDebugInfo(result.companion as Uint8Array)).toBeNull();
    expect(externalDebugInfo(result.module)).toBe("app.debug.wasm");
  });
});

describe("moduleChanged", () => {
  test("is false when there is nothing to do, companion or not", () => {
    const input = wasmModule([
      section(CODE_SECTION_ID, fromHex("01")),
      customSection("build_id", byteVector(fromHex("00".repeat(16)))),
    ]);

    const result = splitWasm(input);

    expect(result.moduleChanged).toBe(false);
    expect(toHex(result.module)).toBe(toHex(input));
    // Requesting a companion reads the module but never rewrites it.
    expect(splitWasm(input, { companion: true }).moduleChanged).toBe(false);
  });

  test("is false when stripping finds nothing to strip", () => {
    const input = wasmModule([
      section(CODE_SECTION_ID, fromHex("01")),
      customSection("build_id", byteVector(fromHex("00".repeat(16)))),
    ]);

    const result = splitWasm(input, { strip: true });

    expect(result.moduleChanged).toBe(false);
    expect(toHex(result.module)).toBe(toHex(input));
  });
});
