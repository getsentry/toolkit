/**
 * Tests for the DIF (debug information file) parser.
 *
 * Uses Breakpad symbol files as fixtures because they are a deterministic,
 * portable TEXT format — no committed binary fixtures or platform-specific
 * system binaries required. The same WASM code path parses Mach-O/ELF/PE/PDB.
 */

import { describe, expect, test } from "vitest";
import {
  createSourceBundle,
  listSources,
  parseDebugFile,
  peekFormat,
  selectBundledObject,
} from "../../../src/lib/dif/index.js";

/** A minimal, valid Breakpad symbol file with a known debug id + code id. */
const BREAKPAD_FIXTURE = [
  "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
  "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
  "FUNC 1000 10 0 main",
  "1000 10 42 1",
  "PUBLIC 2000 0 some_symbol",
].join("\n");

/** Breakpad file that references one source file (FILE 0) via a line record. */
const BREAKPAD_WITH_SOURCE = [
  "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
  "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
  "FILE 0 /src/example.c",
  "FUNC 1000 10 0 main",
  "1000 10 42 0",
].join("\n");

function toBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("peekFormat", () => {
  test("detects breakpad", () => {
    expect(peekFormat(toBytes(BREAKPAD_FIXTURE))).toBe("breakpad");
  });

  test("returns unknown for unrecognized data", () => {
    expect(peekFormat(toBytes("not an object file"))).toBe("unknown");
  });

  test("returns unknown for empty input", () => {
    expect(peekFormat(new Uint8Array())).toBe("unknown");
  });
});

describe("parseDebugFile", () => {
  test("extracts metadata from a Breakpad file", () => {
    const archive = parseDebugFile(toBytes(BREAKPAD_FIXTURE));
    expect(archive.fileFormat).toBe("breakpad");
    expect(archive.objects).toHaveLength(1);

    const obj = archive.objects[0];
    expect(obj).toBeDefined();
    expect(obj?.debugId).toBe("0f13a5da-412a-fbf7-c866-2048f3294f3d");
    expect(obj?.codeId).toBe("daa5130f2a41f7fbc8662048f3294f3d439ca7ff");
    expect(obj?.arch).toBe("x86_64");
    expect(obj?.fileFormat).toBe("breakpad");
    expect(obj?.hasSymbols).toBe(true);
  });

  test("normalizes the debug id to lowercase UUID form", () => {
    const archive = parseDebugFile(toBytes(BREAKPAD_FIXTURE));
    expect(archive.objects[0]?.debugId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  test("is deterministic for the same input", () => {
    const a = parseDebugFile(toBytes(BREAKPAD_FIXTURE));
    const b = parseDebugFile(toBytes(BREAKPAD_FIXTURE));
    expect(a).toEqual(b);
  });

  test("throws on unrecognized data", () => {
    expect(() => parseDebugFile(toBytes("not an object file"))).toThrow();
  });

  test("throws on empty input", () => {
    expect(() => parseDebugFile(new Uint8Array())).toThrow();
  });

  test("renders a nil debug id as the hyphenated nil UUID", () => {
    // Guards the check command's nil-id sentinel against format drift.
    const archive = parseDebugFile(
      toBytes("MODULE Linux x86_64 000000000000000000000000000000000 x")
    );
    expect(archive.objects[0]?.debugId).toBe(
      "00000000-0000-0000-0000-000000000000"
    );
  });
});

describe("createSourceBundle", () => {
  test("bundles a referenced source file supplied by the provider", () => {
    const requested: string[] = [];
    const result = createSourceBundle(
      toBytes(BREAKPAD_WITH_SOURCE),
      "example",
      (path) => {
        requested.push(path);
        return toBytes(`// ${path}`);
      }
    );

    expect(requested).toContain("/src/example.c");
    expect(result.fileCount).toBe(1);
    expect(result.debugId).toBe("0f13a5da-412a-fbf7-c866-2048f3294f3d");
    expect(result.bundle).toBeInstanceOf(Uint8Array);
    expect((result.bundle as Uint8Array).length).toBeGreaterThan(0);
  });

  test("produces no bundle when the provider supplies nothing", () => {
    const result = createSourceBundle(
      toBytes(BREAKPAD_WITH_SOURCE),
      "example",
      () => null
    );
    expect(result.fileCount).toBe(0);
    expect(result.bundle).toBeNull();
  });

  test("produces no bundle when the object references no sources", () => {
    const result = createSourceBundle(
      toBytes(BREAKPAD_FIXTURE),
      "example",
      () => toBytes("unused")
    );
    expect(result.fileCount).toBe(0);
    expect(result.bundle).toBeNull();
  });

  test("surfaces a provider error as a throw (not a silent partial bundle)", () => {
    // The error crosses the wasm boundary, so the original message isn't
    // preserved; what matters is that it throws rather than skipping silently.
    expect(() =>
      createSourceBundle(toBytes(BREAKPAD_WITH_SOURCE), "example", () => {
        throw new Error("read failed");
      })
    ).toThrow();
  });

  test("throws on unrecognized data", () => {
    expect(() =>
      createSourceBundle(toBytes("not an object file"), "x", () => null)
    ).toThrow();
  });
});

describe("listSources", () => {
  test("lists the source files an object references", () => {
    const info = listSources(toBytes(BREAKPAD_WITH_SOURCE));
    expect(info.objects).toHaveLength(1);

    const object = info.objects[0];
    expect(object?.debugId).toBe("0f13a5da-412a-fbf7-c866-2048f3294f3d");
    expect(object?.fileFormat).toBe("breakpad");
    expect(object?.hasDebugInfo).toBe(true);
    expect(object?.enumerationError).toBeNull();
    expect(object?.files).toHaveLength(1);

    const file = object?.files[0];
    expect(file?.path).toBe("/src/example.c");
    // Breakpad references files but embeds no source content.
    expect(file?.resolved).toBe(false);
    expect(file?.type).toBeNull();
  });

  test("returns an empty file list for an object with no referenced sources", () => {
    const info = listSources(toBytes(BREAKPAD_FIXTURE));
    expect(info.objects).toHaveLength(1);
    expect(info.objects[0]?.files).toHaveLength(0);
  });

  test("throws on unrecognized data", () => {
    expect(() => listSources(toBytes("not an object file"))).toThrow();
  });
});

describe("selectBundledObject", () => {
  test("prefers the first object that carries debug info", () => {
    const objects = [
      { hasDebugInfo: false, id: "a" },
      { hasDebugInfo: true, id: "b" },
      { hasDebugInfo: true, id: "c" },
    ];
    expect(selectBundledObject(objects)?.id).toBe("b");
  });

  test("falls back to the first object when none carry debug info", () => {
    const objects = [
      { hasDebugInfo: false, id: "a" },
      { hasDebugInfo: false, id: "b" },
    ];
    expect(selectBundledObject(objects)?.id).toBe("a");
  });

  test("returns undefined for an empty archive", () => {
    expect(selectBundledObject([])).toBeUndefined();
  });
});
