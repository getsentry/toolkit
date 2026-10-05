import { describe, expect, test } from "vitest";
import {
  getInkFrameMargin,
  getInkFrameWidth,
} from "../../../../src/lib/init/ui/ink-frame.js";

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

describe("getInkFrameMargin", () => {
  test("centers the frame when terminal is wider than the frame", () => {
    // (140 - 120) / 2 = 10
    expect(getInkFrameMargin(140, 120)).toBe(10);
    // (130 - 100) / 2 = 15
    expect(getInkFrameMargin(130, 100)).toBe(15);
  });

  test("floors the margin when the difference is odd", () => {
    // (121 - 120) / 2 = 0.5 → floor → 0
    expect(getInkFrameMargin(121, 120)).toBe(0);
    // (123 - 120) / 2 = 1.5 → floor → 1
    expect(getInkFrameMargin(123, 120)).toBe(1);
  });

  test("returns 0 when terminal equals frame width", () => {
    expect(getInkFrameMargin(120, 120)).toBe(0);
  });

  test("returns 0 when frame is wider than terminal (never negative)", () => {
    expect(getInkFrameMargin(60, 80)).toBe(0);
    expect(getInkFrameMargin(79, 120)).toBe(0);
  });
});
