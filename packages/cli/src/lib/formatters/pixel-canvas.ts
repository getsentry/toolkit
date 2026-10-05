/**
 * Small dependency-free primitives for composing sixel raster output.
 *
 * Charts and dashboards use this module to draw into the RGBA buffers consumed
 * by the sixel encoder. The text renderer is deliberately limited to a compact
 * terminal-sized bitmap font. Common punctuation and diacritics are normalized
 * before drawing so they remain legible even outside the embedded font subset.
 */

import type { DecodedImage } from "../sixel-image.js";
import {
  getSpleenGlyph,
  hasSpleenGlyph,
  SPLEEN_CELL_HEIGHT,
  SPLEEN_CELL_WIDTH,
} from "./spleen-font.js";

/** Unicode punctuation that has a clear one- or two-cell ASCII equivalent. */
const BITMAP_TEXT_FALLBACKS = new Map<string, string>([
  ["–", "-"],
  ["—", "-"],
  ["−", "-"],
  ["“", '"'],
  ["”", '"'],
  ["‘", "'"],
  ["’", "'"],
  ["•", "*"],
  ["→", "->"],
  ["←", "<-"],
  ["↔", "<->"],
  [" ", " "],
]);

const COMBINING_MARK_RE = /\p{Mark}/gu;

/** An RGB color tuple with one 0-255 value per channel. */
export type Rgb = [number, number, number];

/** Options for creating a pixel canvas. */
export type CreatePixelCanvasOptions = {
  /** Canvas width in pixels. */
  width: number;
  /** Canvas height in pixels. */
  height: number;
  /** Optional opaque background fill. A missing value leaves pixels transparent. */
  background?: Rgb;
};

/** Options for drawing a filled rectangle. */
export type PixelRectOptions = {
  /** Left edge in pixels. */
  x: number;
  /** Top edge in pixels. */
  y: number;
  /** Rectangle width in pixels. */
  width: number;
  /** Rectangle height in pixels. */
  height: number;
  /** Fill color. */
  color: Rgb;
};

/** Options for drawing one line of terminal-sized bitmap text. */
export type PixelTextOptions = {
  /** Left edge in pixels. */
  x: number;
  /** Top edge in pixels. */
  y: number;
  /** Width of one terminal cell in pixels. */
  cellWidth: number;
  /** Height of one terminal cell in pixels. */
  cellHeight: number;
  /** Maximum number of terminal cells to draw. */
  maxColumns: number;
  /** Glyph color. */
  color: Rgb;
};

/** Create an RGBA pixel canvas, optionally initialized to an opaque color. */
export function createPixelCanvas(
  options: CreatePixelCanvasOptions
): DecodedImage {
  const width = Math.max(1, Math.floor(options.width));
  const height = Math.max(1, Math.floor(options.height));
  const data = new Uint8Array(width * height * 4);
  if (options.background) {
    const [r, g, b] = options.background;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Draw a filled rectangle, clipping it to the canvas bounds. */
export function drawPixelRect(
  image: DecodedImage,
  options: PixelRectOptions
): void {
  const x0 = Math.max(0, Math.floor(options.x));
  const y0 = Math.max(0, Math.floor(options.y));
  const x1 = Math.min(image.width, Math.ceil(options.x + options.width));
  const y1 = Math.min(image.height, Math.ceil(options.y + options.height));
  const [r, g, b] = options.color;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * image.width + x) * 4;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = 255;
    }
  }
}

/** Copy non-transparent source pixels into a destination image. */
export function blitPixelImage(
  destination: DecodedImage,
  source: DecodedImage,
  x: number,
  y: number
): void {
  const destX = Math.floor(x);
  const destY = Math.floor(y);
  const firstSourceX = Math.max(0, -destX);
  const lastSourceX = Math.min(source.width, destination.width - destX);
  const firstSourceY = Math.max(0, -destY);
  const lastSourceY = Math.min(source.height, destination.height - destY);

  for (let sourceY = firstSourceY; sourceY < lastSourceY; sourceY += 1) {
    const targetY = destY + sourceY;
    for (let sourceX = firstSourceX; sourceX < lastSourceX; sourceX += 1) {
      const targetX = destX + sourceX;
      copyOpaquePixel(
        destination,
        source,
        { x: sourceX, y: sourceY },
        {
          x: targetX,
          y: targetY,
        }
      );
    }
  }
}

/** A pixel position in an image buffer. */
type PixelPoint = { x: number; y: number };

/** Copy one source pixel when it is not transparent. */
function copyOpaquePixel(
  destination: DecodedImage,
  source: DecodedImage,
  sourcePoint: PixelPoint,
  targetPoint: PixelPoint
): void {
  const { x: sourceX, y: sourceY } = sourcePoint;
  const { x: targetX, y: targetY } = targetPoint;
  const sourceOffset = (sourceY * source.width + sourceX) * 4;
  if ((source.data[sourceOffset + 3] ?? 0) === 0) {
    return;
  }
  const targetOffset = (targetY * destination.width + targetX) * 4;
  destination.data[targetOffset] = source.data[sourceOffset] ?? 0;
  destination.data[targetOffset + 1] = source.data[sourceOffset + 1] ?? 0;
  destination.data[targetOffset + 2] = source.data[sourceOffset + 2] ?? 0;
  destination.data[targetOffset + 3] = source.data[sourceOffset + 3] ?? 255;
}

/** Draw a Spleen text line, scaled and clipped to its terminal cells. */
export function drawPixelText(
  image: DecodedImage,
  text: string,
  options: PixelTextOptions
): void {
  const cellWidth = Math.max(1, Math.floor(options.cellWidth));
  const cellHeight = Math.max(1, Math.floor(options.cellHeight));

  let column = 0;
  const characters = normalizeBitmapText(text)[Symbol.iterator]();
  while (column < options.maxColumns) {
    const character = characters.next();
    if (character.done) {
      break;
    }
    const rawChar = character.value;
    drawSpleenGlyph(image, getSpleenGlyph(rawChar), {
      x: options.x + column * cellWidth,
      y: options.y,
      cellWidth,
      cellHeight,
      color: options.color,
    });
    column += 1;
  }
}

/** Convert common Unicode text into glyphs that the embedded font can draw. */
function* normalizeBitmapText(text: string): Iterable<string> {
  for (const character of text) {
    if (hasSpleenGlyph(character)) {
      yield character;
      continue;
    }
    const fallback = BITMAP_TEXT_FALLBACKS.get(character);
    if (fallback) {
      yield* fallback;
      continue;
    }
    const decomposed = character
      .normalize("NFKD")
      .replace(COMBINING_MARK_RE, "");
    if (
      decomposed.length > 0 &&
      [...decomposed].every((candidate) => hasSpleenGlyph(candidate))
    ) {
      yield* decomposed;
      continue;
    }
    yield "?";
  }
}

type SpleenGlyphOptions = {
  x: number;
  y: number;
  cellWidth: number;
  cellHeight: number;
  color: Rgb;
};

function drawSpleenGlyph(
  image: DecodedImage,
  glyph: Uint8Array,
  options: SpleenGlyphOptions
): void {
  for (let row = 0; row < SPLEEN_CELL_HEIGHT; row += 1) {
    const pattern = glyph[row] ?? 0;
    for (let column = 0; column < SPLEEN_CELL_WIDTH; column += 1) {
      if (!isSpleenPixelSet(pattern, column)) {
        continue;
      }
      drawSpleenPixel(image, { ...options, row, column });
    }
  }
}

function isSpleenPixelSet(pattern: number, column: number): boolean {
  const divisor = 2 ** (SPLEEN_CELL_WIDTH - 1 - column);
  return Math.floor(pattern / divisor) % 2 === 1;
}

type SpleenPixelOptions = SpleenGlyphOptions & {
  row: number;
  column: number;
};

function drawSpleenPixel(
  image: DecodedImage,
  options: SpleenPixelOptions
): void {
  const x =
    options.x +
    scaleCoordinate(options.column, options.cellWidth, SPLEEN_CELL_WIDTH);
  const y =
    options.y +
    scaleCoordinate(options.row, options.cellHeight, SPLEEN_CELL_HEIGHT);
  const right =
    options.x +
    scaleCoordinate(options.column + 1, options.cellWidth, SPLEEN_CELL_WIDTH);
  const bottom =
    options.y +
    scaleCoordinate(options.row + 1, options.cellHeight, SPLEEN_CELL_HEIGHT);
  drawPixelRect(image, {
    x,
    y,
    width: right - x,
    height: bottom - y,
    color: options.color,
  });
}

/** Scale a Spleen bitmap coordinate to its terminal-cell boundary. */
function scaleCoordinate(
  coordinate: number,
  cellSize: number,
  glyphSize: number
): number {
  return Math.floor((coordinate * cellSize) / glyphSize);
}
