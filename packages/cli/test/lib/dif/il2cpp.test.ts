/**
 * Tests for Unity IL2CPP line-mapping extraction and IL2CPP source collection.
 *
 * Uses text Breakpad fixtures (which reference source files via `FILE` records)
 * plus synthetic C++/C# provider content, so no binary fixtures are needed. The
 * extraction runs through the `@sentry/symbolic` WASM module.
 */

import { unzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  createIl2cppLineMapping,
  createSourceBundle,
} from "../../../src/lib/dif/index.js";

const CPP_PATH = "/src/Game.cpp";
const CS_PATH = "/src/Game.cs";
const KNOWN_DEBUG_ID = "0f13a5da-412a-fbf7-c866-2048f3294f3d";

/** Breakpad object referencing one C++ source file via a FILE record. */
const BREAKPAD_WITH_CPP = [
  "MODULE Linux x86_64 0F13A5DA412AFBF7C8662048F3294F3D0 example",
  "INFO CODE_ID DAA5130F2A41F7FBC8662048F3294F3D439CA7FF",
  `FILE 0 ${CPP_PATH}`,
  "FUNC 1000 10 0 main",
  "1000 10 42 0",
].join("\n");

/** Generated C++ carrying an IL2CPP source_info marker mapping to a C# file. */
const CPP_WITH_SOURCE_INFO = `//<source_info:${CS_PATH}:42>\nint generated = 0;\n`;

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("createIl2cppLineMapping", () => {
  test("computes a mapping from source_info markers via the provider", () => {
    const calls: string[] = [];
    const result = createIl2cppLineMapping(bytes(BREAKPAD_WITH_CPP), (path) => {
      calls.push(path);
      return bytes(CPP_WITH_SOURCE_INFO);
    });
    expect(calls).toContain(CPP_PATH);
    expect(result).not.toBeNull();
    if (!result) {
      return;
    }
    expect(result.debugId).toBe(KNOWN_DEBUG_ID);
    const doc = JSON.parse(new TextDecoder().decode(result.mapping)) as Record<
      string,
      Record<string, unknown>
    >;
    expect(doc[CPP_PATH]?.[CS_PATH]).toBeDefined();
  });

  test("returns the mapped object's own debug id when targeting by id", () => {
    // The returned debug id must always describe the object the mapping came
    // from, so the uploaded DIF can be stamped with a matching id.
    const result = createIl2cppLineMapping(
      bytes(BREAKPAD_WITH_CPP),
      () => bytes(CPP_WITH_SOURCE_INFO),
      KNOWN_DEBUG_ID
    );
    expect(result?.debugId).toBe(KNOWN_DEBUG_ID);
  });

  test("falls back to the primary object when targetDebugId is not found", () => {
    const result = createIl2cppLineMapping(
      bytes(BREAKPAD_WITH_CPP),
      () => bytes(CPP_WITH_SOURCE_INFO),
      "ffffffff-ffff-ffff-ffff-ffffffffffff"
    );
    expect(result?.debugId).toBe(KNOWN_DEBUG_ID);
  });

  test("returns null when no referenced source is available", () => {
    expect(
      createIl2cppLineMapping(bytes(BREAKPAD_WITH_CPP), () => null)
    ).toBeNull();
  });

  test("returns null when the C++ has no source_info markers", () => {
    expect(
      createIl2cppLineMapping(bytes(BREAKPAD_WITH_CPP), () =>
        bytes("int plain = 0;\n")
      )
    ).toBeNull();
  });
});

describe("createSourceBundle collectIl2cppSources", () => {
  const sources: Record<string, Uint8Array> = {
    [CPP_PATH]: bytes(CPP_WITH_SOURCE_INFO),
    [CS_PATH]: bytes("class Game {}\n"),
  };
  const read = (p: string): Uint8Array | null => sources[p] ?? null;

  function bundleFiles(bundle: Uint8Array | null): string[] {
    if (!bundle) {
      return [];
    }
    return Object.keys(unzipSync(bundle)).filter((f) => f.startsWith("files/"));
  }

  test("includes referenced C# sources when enabled", () => {
    const result = createSourceBundle(
      bytes(BREAKPAD_WITH_CPP),
      "example",
      read,
      {
        collectIl2cppSources: true,
      }
    );
    const files = bundleFiles(result.bundle);
    expect(files).toContain(`files${CPP_PATH}`);
    expect(files).toContain(`files${CS_PATH}`);
  });

  test("omits C# sources when disabled", () => {
    const result = createSourceBundle(
      bytes(BREAKPAD_WITH_CPP),
      "example",
      read
    );
    const files = bundleFiles(result.bundle);
    expect(files).toContain(`files${CPP_PATH}`);
    expect(files).not.toContain(`files${CS_PATH}`);
  });
});
