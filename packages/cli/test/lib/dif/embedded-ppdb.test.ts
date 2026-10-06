/**
 * Tests for embedded Portable PDB extraction from managed PE assemblies.
 *
 * Uses small committed .NET PE fixtures (from the Sentry sample console app):
 * one that embeds a Portable PDB and one that does not. Extraction runs through
 * the `@sentry/symbolic` WASM module, so this also exercises the `asPe()` →
 * `embeddedPpdb()` binding end-to-end.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  extractEmbeddedPpdb,
  parseDebugFile,
} from "../../../src/lib/dif/index.js";

/** Read a committed binary DIF fixture as raw bytes. */
function readFixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../../fixtures/dif/${name}`, import.meta.url))
  );
}

/** Debug id of the managed PE fixture (shared by its embedded Portable PDB). */
const EMBEDDED_PE_DEBUG_ID = "d8eb7dca-4883-4b10-a1f7-048ea1ea388b-cfb0fc89";

describe("extractEmbeddedPpdb", () => {
  test("extracts an embedded Portable PDB from a managed PE", () => {
    const result = extractEmbeddedPpdb(readFixture("embedded-ppdb.dll"));
    expect(result).not.toBeNull();
    expect(result?.debugId).toBe(EMBEDDED_PE_DEBUG_ID);
    expect(result?.ppdb.byteLength).toBeGreaterThan(0);
  });

  test("the extracted bytes are themselves a standalone Portable PDB", () => {
    const result = extractEmbeddedPpdb(readFixture("embedded-ppdb.dll"));
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    const parsed = parseDebugFile(result.ppdb);
    expect(parsed.fileFormat).toBe("portablepdb");
    // The embedded PPDB carries the same debug id as its parent PE, which is
    // why using the PE's debug id as the extracted DIF's advisory id is correct.
    expect(parsed.objects[0]?.debugId).toBe(EMBEDDED_PE_DEBUG_ID);
  });

  test("returns null for a PE without an embedded Portable PDB", () => {
    expect(extractEmbeddedPpdb(readFixture("pe-no-ppdb.dll"))).toBeNull();
  });

  test("returns null for a non-PE object", () => {
    const breakpad = new TextEncoder().encode(
      [
        "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
        "FUNC 1000 10 0 main",
      ].join("\n")
    );
    expect(extractEmbeddedPpdb(breakpad)).toBeNull();
  });
});
