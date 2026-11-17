/**
 * Sparkline and downsample handling of points with no measurement.
 *
 * Invariants for numeric input live in sparkline.property.test.ts.
 */

import { describe, expect, test } from "vitest";
import {
  downsample,
  downsampleFlags,
  sparkline,
} from "../../../src/lib/formatters/sparkline.js";

describe("downsample", () => {
  test("averages only measured points in a bucket", () => {
    expect(downsample([100, null, 300, 500], 2)).toEqual([100, 400]);
  });

  test("keeps a bucket with no measurement null", () => {
    expect(downsample([null, null, 0, 0], 2)).toEqual([null, 0]);
  });
});

describe("sparkline", () => {
  test("renders an unmeasured point as a gap, not a zero", () => {
    expect(sparkline([0, null, 8])).toBe("⎽ █");
  });

  test("renders all-unmeasured input as gaps", () => {
    expect(sparkline([null, null, null])).toBe("   ");
  });
});

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
