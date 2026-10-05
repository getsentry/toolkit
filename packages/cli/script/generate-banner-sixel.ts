#!/usr/bin/env tsx
/**
 * Generate the Sixel Banner
 *
 * Bakes the Sentry arch + SENTRY wordmark into a sixel escape sequence that
 * high-fidelity (sixel-capable) terminals render as a real image, matching the
 * brand gradient of the block-art fallback in `src/lib/banner.ts`.
 *
 * The source is a white-on-transparent alpha mask (`assets/banner-mask.png`);
 * this script applies the vertical brand gradient per row and emits a
 * TRANSPARENT sixel (unpainted pixels are left undrawn, so the banner floats on
 * the terminal background just like the block-art banner — no opaque rectangle).
 *
 * Output is a committed module (like `src/generated/skill-content.ts`) so the
 * runtime never needs an image library — it just prints the baked string when a
 * terminal advertises sixel support.
 *
 * Usage:   tsx script/generate-banner-sixel.ts
 * Output:  src/generated/banner-sixel.ts
 */

import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const MASK_PATH = join(REPO_ROOT, "assets", "banner-mask.png");
const OUT_PATH = join(REPO_ROOT, "src", "generated", "banner-sixel.ts");

/**
 * Vertical brand gradient anchors (top → bottom), matching `BANNER_GRADIENT`
 * in `src/lib/banner.ts`: #9E86FF (top), #7553FF (middle), #583FC1 (bottom).
 */
const GRADIENT_ANCHORS: [number, number, number][] = [
  [0x9e, 0x86, 0xff],
  [0x75, 0x53, 0xff],
  [0x58, 0x3f, 0xc1],
];

/** Number of quantized gradient bands (palette entries). Keeps the sixel small
 *  while staying visually smooth across the wordmark height. */
const COLOR_BANDS = 24;

/** Alpha (0–255) at or above which a mask pixel is painted; below is left
 *  transparent. A hard threshold keeps letterform edges crisp and the palette
 *  tiny (partial-alpha edges can't be blended without knowing the terminal bg). */
const ALPHA_THRESHOLD = 110;

/** Linearly interpolate the brand gradient at t ∈ [0,1] → [r,g,b] (0–255). */
function gradientAt(t: number): [number, number, number] {
  const clamped = Math.min(1, Math.max(0, t));
  const seg = clamped * (GRADIENT_ANCHORS.length - 1);
  const i = Math.min(GRADIENT_ANCHORS.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = GRADIENT_ANCHORS[i] as [number, number, number];
  const b = GRADIENT_ANCHORS[i + 1] as [number, number, number];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** Sixel palette component scale is 0–100 (percent), not 0–255. */
const to100 = (v: number): number => Math.round((v / 255) * 100);

/** A painted-pixel test plus a row→color-band mapping over one image. */
type MaskModel = {
  width: number;
  height: number;
  /** True when pixel (x,y) should be drawn (alpha ≥ threshold). */
  isPainted: (x: number, y: number) => boolean;
  /** Palette index for the given row (vertical gradient). */
  bandForRow: (y: number) => number;
};

/** Palette indices with at least one painted pixel in the 6-row band at `y0`. */
function colorsInBand(model: MaskModel, y0: number): number[] {
  const seen = new Set<number>();
  for (let x = 0; x < model.width; x++) {
    for (let i = 0; i < 6; i++) {
      const y = y0 + i;
      if (y < model.height && model.isPainted(x, y)) {
        seen.add(model.bandForRow(y));
      }
    }
  }
  return [...seen];
}

/**
 * Encode one color plane of a 6-row band as run-length-encoded sixel chars.
 * Each column contributes one char whose value's bit `i` marks pixel row `y0+i`
 * painted in this color (built with `2**i` to avoid bitwise operators).
 */
function encodeColorBand(model: MaskModel, y0: number, color: number): string {
  const parts: string[] = [];
  let runChar = -1;
  let runLen = 0;
  const flush = (): void => {
    if (runLen > 0) {
      const ch = String.fromCharCode(runChar);
      parts.push(runLen > 3 ? `!${runLen}${ch}` : ch.repeat(runLen));
      runLen = 0;
    }
  };
  for (let x = 0; x < model.width; x++) {
    let value = 0;
    for (let i = 0; i < 6; i++) {
      const y = y0 + i;
      if (
        y < model.height &&
        model.isPainted(x, y) &&
        model.bandForRow(y) === color
      ) {
        value += 2 ** i;
      }
    }
    const ch = 0x3f + value;
    if (ch === runChar) {
      runLen += 1;
    } else {
      flush();
      runChar = ch;
      runLen = 1;
    }
  }
  flush();
  return `#${color}${parts.join("")}`;
}

/**
 * Encode an alpha mask as a transparent sixel string.
 *
 * Color is a function of the row only (vertical gradient), quantized into
 * `COLOR_BANDS` palette entries. Unpainted pixels are never set in any color
 * plane, so with sixel P2=1 they remain transparent.
 */
function encodeSixel(png: PNG): string {
  const { width, height, data } = png;

  const palette: [number, number, number][] = [];
  for (let n = 0; n < COLOR_BANDS; n++) {
    palette.push(gradientAt((n + 0.5) / COLOR_BANDS));
  }
  const model: MaskModel = {
    width,
    height,
    isPainted: (x, y) =>
      (data[(y * width + x) * 4 + 3] ?? 0) >= ALPHA_THRESHOLD,
    bandForRow: (y) =>
      Math.min(
        COLOR_BANDS - 1,
        Math.floor((y / Math.max(1, height - 1)) * COLOR_BANDS)
      ),
  };

  // DCS: P1=0 aspect, P2=1 (unpainted = transparent), P3=0 grid; then raster
  // attributes "1;1;W;H so the terminal reserves the right pixel box.
  let out = `\x1bP0;1;0q"1;1;${width};${height}`;
  palette.forEach(([r, g, b], i) => {
    out += `#${i};2;${to100(r)};${to100(g)};${to100(b)}`;
  });

  const totalBands = Math.ceil(height / 6);
  for (let band = 0; band < totalBands; band++) {
    const y0 = band * 6;
    // Colors joined by "$" (graphics CR) overprint on the same band.
    out += colorsInBand(model, y0)
      .map((c) => encodeColorBand(model, y0, c))
      .join("$");
    // Graphics newline between bands (not after the last, to avoid a blank row).
    if (band < totalBands - 1) {
      out += "-";
    }
  }

  out += "\x1b\\"; // String Terminator
  return out;
}

async function main(): Promise<void> {
  const png = PNG.sync.read(readFileSync(MASK_PATH));
  const sixel = encodeSixel(png);

  // generate:banner runs first in the pipeline, so on a fresh checkout it may
  // be the first writer into the (gitignored) src/generated directory.
  mkdirSync(dirname(OUT_PATH), { recursive: true });

  const module = `// AUTO-GENERATED by script/generate-banner-sixel.ts — DO NOT EDIT.
// Regenerate with: pnpm run generate:banner
/**
 * Baked transparent-sixel banner (Sentry arch + SENTRY wordmark, brand
 * gradient). Printed by the CLI on terminals that advertise sixel support;
 * everything else falls back to the block-art banner in src/lib/banner.ts.
 */
export const BANNER_SIXEL = {
  /** Full DCS sixel escape sequence, ready to write to a TTY. */
  data: ${JSON.stringify(sixel)},
  /** Rendered image size in device pixels. */
  width: ${png.width},
  height: ${png.height},
} as const;
`;

  await writeFile(OUT_PATH, module, "utf8");
  process.stdout.write(
    `Wrote ${OUT_PATH} (${png.width}x${png.height}, sixel ${sixel.length} bytes)\n`
  );
}

main().catch((err) => {
  process.stderr.write(`generate-banner-sixel failed: ${String(err)}\n`);
  process.exit(1);
});
