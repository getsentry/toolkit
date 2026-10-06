import { describe, expect, test, vi } from "vitest";
import {
  createPixelCanvas,
  drawPixelText,
} from "../../../src/lib/formatters/pixel-canvas.js";
import { getSpleenGlyph } from "../../../src/lib/formatters/spleen-font.js";

function opaquePixelCount(image: { data: Uint8Array }): number {
  let count = 0;
  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] === 255) {
      count += 1;
    }
  }
  return count;
}

describe("drawPixelText", () => {
  test("uses Spleen's native 8x16 raster at terminal cell size", () => {
    const image = createPixelCanvas({ width: 8, height: 16 });

    drawPixelText(image, "A", {
      x: 0,
      y: 0,
      cellWidth: 8,
      cellHeight: 16,
      maxColumns: 1,
      color: [255, 255, 255],
    });

    expect(opaquePixelCount(image)).toBe(44);
    expect(image.data[(2 * image.width + 2) * 4 + 3]).toBe(255);
    expect(image.data[(0 * image.width + 1) * 4 + 3]).toBe(0);
  });

  test("keeps Spleen's native box and block glyphs for dashboard content", () => {
    expect([...getSpleenGlyph("▀")]).toEqual([
      255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect([...getSpleenGlyph("─")]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  test("uses a question mark for unsupported text glyphs", () => {
    expect([...getSpleenGlyph("\u6f22")]).toEqual([...getSpleenGlyph("?")]);
  });

  test("includes the dashboard axis, sparkline, and ellipsis glyphs", () => {
    const questionMark = [...getSpleenGlyph("?")];
    for (const character of [
      "│",
      "└",
      "┤",
      "┬",
      "…",
      "▁",
      "▂",
      "▃",
      "▄",
      "▅",
      "▆",
      "▇",
      "░",
      "▓",
      "■",
    ]) {
      expect([...getSpleenGlyph(character)]).not.toEqual(questionMark);
    }
  });

  test("renders accented labels and typographic punctuation legibly", () => {
    const rendered = renderText("Café — 50…");
    const expected = renderText("Cafe - 50…");

    expect(rendered.data).toEqual(expected.data);
  });

  test("does not normalize text outside its visible width", () => {
    const normalize = vi.spyOn(String.prototype, "normalize");
    const image = createPixelCanvas({ width: 8, height: 16 });

    try {
      drawPixelText(image, `A${"é".repeat(100)}`, {
        x: 0,
        y: 0,
        cellWidth: 8,
        cellHeight: 16,
        maxColumns: 1,
        color: [255, 255, 255],
      });

      expect(normalize).not.toHaveBeenCalled();
    } finally {
      normalize.mockRestore();
    }
  });

  test("fills non-integer terminal cells with proportional bitmap scaling", () => {
    const image = createPixelCanvas({ width: 9, height: 18 });

    drawPixelText(image, "A", {
      x: 0,
      y: 0,
      cellWidth: 9,
      cellHeight: 18,
      maxColumns: 1,
      color: [255, 255, 255],
    });

    expect(opaquePixelCount(image)).toBe(48);
    expect(image.data[(2 * image.width + 3) * 4 + 3]).toBe(255);
  });

  test("uses proportional scaling for larger cells", () => {
    const image = createPixelCanvas({ width: 12, height: 26 });

    drawPixelText(image, "A", {
      x: 0,
      y: 0,
      cellWidth: 12,
      cellHeight: 26,
      maxColumns: 1,
      color: [255, 255, 255],
    });

    expect(opaquePixelCount(image)).toBe(106);
  });

  test("never draws outside an undersized terminal cell", () => {
    const image = createPixelCanvas({ width: 16, height: 16 });

    drawPixelText(image, "AA", {
      x: 4,
      y: 4,
      cellWidth: 4,
      cellHeight: 8,
      maxColumns: 2,
      color: [255, 255, 255],
    });

    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const opaque = image.data[(y * image.width + x) * 4 + 3] === 255;
        if (opaque) {
          expect(x).toBeGreaterThanOrEqual(4);
          expect(x).toBeLessThan(12);
          expect(y).toBeGreaterThanOrEqual(4);
          expect(y).toBeLessThan(12);
        }
      }
    }
  });
});

function renderText(text: string) {
  const image = createPixelCanvas({ width: 160, height: 16 });
  drawPixelText(image, text, {
    x: 0,
    y: 0,
    cellWidth: 8,
    cellHeight: 16,
    maxColumns: 20,
    color: [255, 255, 255],
  });
  return image;
}
