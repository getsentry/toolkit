/**
 * Sparkline helper tests.
 */

import { describe, expect, test } from "vitest";
import { downsampleFlags } from "../../../src/lib/formatters/sparkline.js";

describe("downsampleFlags", () => {
  test("returns the input when it already fits", () => {
    const flags = [false, true, false];
    expect(downsampleFlags(flags, 8)).toBe(flags);
  });

  test("flags a target bucket when any source point is flagged", () => {
    const flags = [false, false, false, false, false, false, false, true];
    expect(downsampleFlags(flags, 4)).toEqual([false, false, false, true]);
  });

  test("uses the same bucket boundaries as downsample", () => {
    // 5 points into 2 buckets: [0,1] and [2,3,4]
    expect(downsampleFlags([true, false, false, false, false], 2)).toEqual([
      true,
      false,
    ]);
    expect(downsampleFlags([false, false, true, false, false], 2)).toEqual([
      false,
      true,
    ]);
  });
});
