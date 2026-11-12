/**
 * Sparkline and downsample handling of points with no measurement.
 *
 * Invariants for numeric input live in sparkline.property.test.ts.
 */

import { describe, expect, test } from "vitest";
import {
  downsample,
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
