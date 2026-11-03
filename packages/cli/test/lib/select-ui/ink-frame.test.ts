import { describe, expect, test } from "vitest";
import { getInkFrameWidth } from "../../../src/lib/select-ui/ink-frame.js";

describe("getInkFrameWidth", () => {
  test("returns terminal width when below the 80-column minimum", () => {
    expect(getInkFrameWidth(60)).toBe(60);
    expect(getInkFrameWidth(40)).toBe(40);
  });

  test("returns 80 at the minimum boundary", () => {
    expect(getInkFrameWidth(80)).toBe(80);
  });

  test("passes through widths between 80 and 120", () => {
    expect(getInkFrameWidth(100)).toBe(100);
    expect(getInkFrameWidth(119)).toBe(119);
  });

  test("caps at 120 columns", () => {
    expect(getInkFrameWidth(120)).toBe(120);
    expect(getInkFrameWidth(200)).toBe(120);
    expect(getInkFrameWidth(999)).toBe(120);
  });
});
