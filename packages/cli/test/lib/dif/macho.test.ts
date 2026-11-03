/**
 * Unit tests for fat Mach-O splitting.
 *
 * The end-to-end upload path for fat dSYMs is covered in
 * test/commands/debug-files/upload.test.ts; these tests pin the header
 * parsing that it relies on.
 */

import { describe, expect, test } from "vitest";
import { parseDebugFile } from "../../../src/lib/dif/index.js";
import { splitFatMachO } from "../../../src/lib/dif/macho.js";
import {
  ARM64,
  thinMachO,
  WATCH_ARM64_32_DEBUG_ID,
  WATCH_ARM64_DEBUG_ID,
  watchFatMachO,
} from "../../fixtures/dif/macho.js";

describe("splitFatMachO", () => {
  test("returns each slice as a thin object with its own debug id", () => {
    const fat = watchFatMachO();
    expect(parseDebugFile(new Uint8Array(fat)).objects).toHaveLength(2);

    const slices = splitFatMachO(fat) ?? [];
    expect(
      slices.map((slice) =>
        parseDebugFile(new Uint8Array(slice)).objects.map((o) => o.debugId),
      ),
    ).toEqual([[WATCH_ARM64_DEBUG_ID], [WATCH_ARM64_32_DEBUG_ID]]);
  });

  test("returns null for a thin Mach-O", () => {
    expect(splitFatMachO(thinMachO(ARM64, WATCH_ARM64_DEBUG_ID))).toBeNull();
  });

  test("returns null when a slice runs past the end of the file", () => {
    const fat = watchFatMachO();
    expect(splitFatMachO(fat.subarray(0, fat.length - 1))).toBeNull();
  });
});
