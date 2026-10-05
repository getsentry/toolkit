/**
 * Runtime image → sixel encoding.
 *
 * Turns a decoded raster image (PNG or JPEG) into a full-color sixel escape
 * sequence for inline display on sixel-capable terminals. This is the runtime
 * companion to {@link ./sixel.ts}, which only knows about the baked, single
 * static banner — here we quantize an arbitrary image to a small palette and
 * emit the sixel bytes on demand.
 *
 * Used by `sentry api` to render image attachments (screenshots, etc.) inline
 * instead of dumping raw bytes into an interactive terminal.
 *
 * Design notes:
 *   - Decoding uses the already-bundled `pngjs` / `jpeg-js` (no new deps, both
 *     pure-JS so they work in the bundled binary).
 *   - Color is quantized to a fixed palette via a median-cut algorithm, keeping
 *     the escape sequence small while staying visually faithful. Sixel palette
 *     components are 0–100 (percent), so colors are downscaled from 0–255.
 *   - Fully-transparent pixels are left undrawn (sixel P2=1), so images with an
 *     alpha channel float on the terminal background.
 *   - Large images are downscaled (nearest-neighbor) so they fit the terminal
 *     and the escape sequence stays a reasonable size.
 */

import { decode as decodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";
import { logger } from "./logger.js";

const log = logger.withTag("sixel-image");

/** A decoded image: RGBA pixels row-major, 4 bytes per pixel. */
export type DecodedImage = {
  width: number;
  height: number;
  /** RGBA bytes, length `width * height * 4`. */
  data: Uint8Array | Buffer;
};

/** Image formats we can decode at runtime. */
export type SupportedImageFormat = "png" | "jpeg";

/** Number of palette entries the image is quantized to. */
const PALETTE_SIZE = 128;

/** Alpha at or above which a pixel is considered opaque enough to draw. */
const ALPHA_THRESHOLD = 128;

/**
 * Default cap on the rendered pixel width. Images wider than this are
 * downscaled so the sixel fits a typical terminal and stays small. Height is
 * scaled proportionally.
 */
export const DEFAULT_MAX_WIDTH = 800;

/**
 * Default cap on the rendered pixel height. Long screenshots (narrow but very
 * tall) would otherwise skip width-based downscaling entirely and produce a
 * huge escape sequence with heavy CPU/memory cost, so height is bounded too.
 */
export const DEFAULT_MAX_HEIGHT = 2000;

/**
 * Hard ceiling on either declared image dimension, checked from the header
 * before the pure-JS decoders allocate `width * height * 4` bytes. A crafted
 * file can claim enormous dimensions in a tiny header (e.g. a 1 KB PNG
 * declaring 100000×100000 would make the decoder request ~40 GB and OOM the
 * process — an OOM that `try/catch` cannot recover from). 20000px comfortably
 * exceeds any real screenshot while bounding a pre-decode allocation to ~1.6 GB
 * worst case for a single dimension.
 */
const MAX_DECODE_DIMENSION = 20_000;

/**
 * True for JPEG marker ids that carry no length-prefixed payload: SOI/EOI
 * (D8/D9), the RSTn restart markers (D0–D7), and TEM (01). These advance the
 * walker by just the two marker bytes.
 */
function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

/**
 * True for JPEG Start-of-Frame markers (SOF0–SOF15, C0–CF) that carry the
 * frame dimensions, excluding the non-frame markers DHT (C4), JPG (C8), and
 * DAC (CC) that share the 0xCn range.
 */
function isSofJpegMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

/**
 * Walk JPEG marker segments looking for a Start-of-Frame and read its declared
 * width/height without decoding pixel data. Returns `undefined` when no SOF is
 * found within the buffer or the stream is malformed.
 */
function readJpegDimensions(
  body: Uint8Array
): { width: number; height: number } | undefined {
  // Must read up to offset+8 (the 2-byte width) for a SOF, so require
  // offset+8 to be in bounds (offset+9 <= body.length).
  let offset = 2; // skip the leading SOI (FF D8)
  while (offset + 9 <= body.length) {
    // Markers begin with 0xFF; runs of 0xFF are legal fill bytes, so skip them
    // one at a time rather than mis-reading them as a length-prefixed segment.
    if (body[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = body[offset + 1] as number;
    if (marker === 0xff) {
      offset += 1; // fill byte; re-examine from the next 0xFF
      continue;
    }
    if (isStandaloneJpegMarker(marker)) {
      offset += 2;
      continue;
    }
    if (isSofJpegMarker(marker)) {
      const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
      // SOF payload: [2-byte length][1-byte precision][2-byte height][2-byte width]
      return {
        height: view.getUint16(offset + 5),
        width: view.getUint16(offset + 7),
      };
    }
    // Length-prefixed segment: advance past the 2-byte length (which counts
    // its own 2 bytes) plus the leading marker.
    const segLength =
      (body[offset + 2] as number) * 256 + (body[offset + 3] as number);
    if (segLength < 2) {
      return; // malformed length; bail rather than loop forever
    }
    offset += 2 + segLength;
  }
  return;
}

/**
 * Read the declared pixel dimensions from a PNG or JPEG header without decoding
 * the pixel data, so callers can reject oversized images before the decoder
 * allocates a full pixel buffer. Returns `undefined` when the header is too
 * short or malformed to read dimensions from.
 *
 * - PNG: the IHDR chunk always follows the 8-byte signature; width and height
 *   are big-endian uint32 at byte offsets 16 and 20.
 * - JPEG: scan the marker segments for a Start-of-Frame and read its payload.
 */
export function readImageDimensions(
  body: Uint8Array,
  format: SupportedImageFormat
): { width: number; height: number } | undefined {
  if (format === "png") {
    if (body.length < 24) {
      return;
    }
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  return readJpegDimensions(body);
}

/**
 * Detect a supported image format from an HTTP Content-Type and/or the leading
 * magic bytes of the body. Returns `undefined` for formats we can't decode.
 *
 * Magic-byte sniffing is the source of truth (servers mislabel attachments);
 * the Content-Type is only used as a fallback when the bytes are inconclusive.
 */
export function detectImageFormat(
  body: Uint8Array,
  contentType?: string | null
): SupportedImageFormat | undefined {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    body.length >= 8 &&
    body[0] === 0x89 &&
    body[1] === 0x50 &&
    body[2] === 0x4e &&
    body[3] === 0x47
  ) {
    return "png";
  }
  // JPEG signature: FF D8 FF
  if (
    body.length >= 3 &&
    body[0] === 0xff &&
    body[1] === 0xd8 &&
    body[2] === 0xff
  ) {
    return "jpeg";
  }
  // Fall back to the declared Content-Type when the bytes were inconclusive.
  const ct = contentType?.toLowerCase() ?? "";
  if (ct.includes("image/png")) {
    return "png";
  }
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) {
    return "jpeg";
  }
  return;
}

/**
 * Decode PNG or JPEG bytes into RGBA pixels. Returns `undefined` if the bytes
 * fail to decode (corrupt or an unexpected sub-format the decoder rejects).
 */
export function decodeImage(
  body: Uint8Array,
  format: SupportedImageFormat
): DecodedImage | undefined {
  const dims = readImageDimensions(body, format);
  if (
    dims &&
    (dims.width > MAX_DECODE_DIMENSION || dims.height > MAX_DECODE_DIMENSION)
  ) {
    log.debug(
      `Refusing to decode ${format} image: declared dimensions ${dims.width}×${dims.height} exceed ${MAX_DECODE_DIMENSION}px cap`
    );
    return;
  }
  try {
    if (format === "png") {
      const png = PNG.sync.read(Buffer.from(body));
      return { width: png.width, height: png.height, data: png.data };
    }
    // jpeg-js: request RGBA output explicitly so the pixel layout matches PNG
    // and pixelAt's 4-byte stride. formatAsRGBA already defaults to true, but
    // pinning it guards against a default change and mirrors snapshots/diff.ts.
    const jpeg = decodeJpeg(Buffer.from(body), {
      useTArray: true,
      formatAsRGBA: true,
    });
    return { width: jpeg.width, height: jpeg.height, data: jpeg.data };
  } catch (error) {
    log.debug(`Failed to decode ${format} image for sixel rendering`, error);
    return;
  }
}

/** Read the RGBA tuple at pixel (x, y). */
function pixelAt(
  img: DecodedImage,
  x: number,
  y: number
): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [
    img.data[i] ?? 0,
    img.data[i + 1] ?? 0,
    img.data[i + 2] ?? 0,
    img.data[i + 3] ?? 255,
  ];
}

/**
 * Downscale an image so it fits within `maxWidth` × `maxHeight` pixels, using
 * nearest-neighbor sampling and preserving aspect ratio (scaled by whichever
 * dimension is over its cap). Returns the source unchanged when it already
 * fits. Cheap and dependency-free — quality is fine for terminal previews.
 *
 * Bounding height as well as width matters for long screenshots: a narrow but
 * very tall image would otherwise skip width-based scaling entirely and blow up
 * the palette pass and escape-sequence size.
 */
export function downscale(
  img: DecodedImage,
  maxWidth: number,
  maxHeight: number
): DecodedImage {
  if (img.width <= maxWidth && img.height <= maxHeight) {
    return img;
  }
  const scale = Math.min(maxWidth / img.width, maxHeight / img.height);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const srcY = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(img.width - 1, Math.floor(x / scale));
      const [r, g, b, a] = pixelAt(img, srcX, srcY);
      const di = (y * width + x) * 4;
      data[di] = r;
      data[di + 1] = g;
      data[di + 2] = b;
      data[di + 3] = a;
    }
  }
  return { width, height, data };
}

/** An RGB color box used by the median-cut quantizer. */
type ColorBox = {
  colors: [number, number, number][];
};

/** The channel (0=r, 1=g, 2=b) with the largest spread in a box. */
function widestChannel(box: ColorBox): { channel: number; spread: number } {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (const c of box.colors) {
    for (let ch = 0; ch < 3; ch++) {
      const v = c[ch] as number;
      if (v < (min[ch] as number)) {
        min[ch] = v;
      }
      if (v > (max[ch] as number)) {
        max[ch] = v;
      }
    }
  }
  const spread = [
    (max[0] as number) - (min[0] as number),
    (max[1] as number) - (min[1] as number),
    (max[2] as number) - (min[2] as number),
  ];
  let widest = 0;
  for (let ch = 1; ch < 3; ch++) {
    if ((spread[ch] as number) > (spread[widest] as number)) {
      widest = ch;
    }
  }
  return { channel: widest, spread: spread[widest] as number };
}

/** Average color of a box, rounded to a single representative RGB tuple. */
function averageColor(box: ColorBox): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const c of box.colors) {
    r += c[0];
    g += c[1];
    b += c[2];
  }
  const n = Math.max(1, box.colors.length);
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Collect the RGB values of every sufficiently-opaque pixel in `img`. */
function collectOpaqueColors(img: DecodedImage): [number, number, number][] {
  const colors: [number, number, number][] = [];
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b, a] = pixelAt(img, x, y);
      if (a >= ALPHA_THRESHOLD) {
        colors.push([r, g, b]);
      }
    }
  }
  return colors;
}

/**
 * Pick the splittable box (spread > 0) with the most colors, or `undefined`
 * when none can be usefully divided further.
 */
function selectSplitTarget(
  boxes: ColorBox[]
): { index: number; channel: number } | undefined {
  let index = -1;
  let channel = 0;
  let maxCount = 0;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i] as ColorBox;
    const widest = widestChannel(box);
    if (widest.spread > 0 && box.colors.length > maxCount) {
      maxCount = box.colors.length;
      index = i;
      channel = widest.channel;
    }
  }
  return index === -1 ? undefined : { index, channel };
}

/** Split a box in two at the median of the given channel. */
function splitBox(box: ColorBox, channel: number): [ColorBox, ColorBox] {
  const sorted = [...box.colors].sort(
    (a, b) => (a[channel] as number) - (b[channel] as number)
  );
  const mid = Math.floor(sorted.length / 2);
  return [{ colors: sorted.slice(0, mid) }, { colors: sorted.slice(mid) }];
}

/**
 * Build a palette of at most `size` colors from the opaque pixels of `img`
 * using median-cut quantization.
 */
export function buildPalette(
  img: DecodedImage,
  size: number
): [number, number, number][] {
  const colors = collectOpaqueColors(img);
  if (colors.length === 0) {
    return [];
  }

  let boxes: ColorBox[] = [{ colors }];
  while (boxes.length < size) {
    const target = selectSplitTarget(boxes);
    if (!target) {
      break;
    }
    const [left, right] = splitBox(
      boxes[target.index] as ColorBox,
      target.channel
    );
    boxes = [
      ...boxes.slice(0, target.index),
      left,
      right,
      ...boxes.slice(target.index + 1),
    ];
  }

  return boxes.filter((box) => box.colors.length > 0).map(averageColor);
}

/** Find the palette index whose color is nearest (squared RGB distance). */
function nearestPaletteIndex(
  palette: [number, number, number][],
  r: number,
  g: number,
  b: number
): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i] as [number, number, number];
    const dr = p[0] - r;
    const dg = p[1] - g;
    const db = p[2] - b;
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Sixel palette component scale is 0–100 (percent), not 0–255. */
const to100 = (v: number): number => Math.round((v / 255) * 100);

/**
 * A quantized image plane: per-pixel palette indices (row-major), where `-1`
 * marks a transparent (undrawn) pixel.
 */
type IndexedPlane = {
  indices: Int32Array;
  width: number;
  height: number;
};

/**
 * Run-length encode one color plane of a 6-row band into sixel characters.
 * Each column contributes one char whose bit `i` marks row `y0+i` painted in
 * `colorIndex`. `!N<char>` is sixel run-length compression.
 */
function encodeColorBand(
  plane: IndexedPlane,
  y0: number,
  colorIndex: number
): string {
  const { indices, width, height } = plane;
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
  for (let x = 0; x < width; x++) {
    let value = 0;
    for (let i = 0; i < 6; i++) {
      const y = y0 + i;
      if (y < height && indices[y * width + x] === colorIndex) {
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
  return `#${colorIndex}${parts.join("")}`;
}

/** Palette indices painted somewhere in the 6-row band starting at `y0`. */
function colorsInBand(plane: IndexedPlane, y0: number): number[] {
  const { indices, width, height } = plane;
  const seen = new Set<number>();
  for (let x = 0; x < width; x++) {
    for (let i = 0; i < 6; i++) {
      const y = y0 + i;
      if (y < height) {
        const idx = indices[y * width + x];
        if (idx !== undefined && idx >= 0) {
          seen.add(idx);
        }
      }
    }
  }
  return [...seen];
}

/**
 * Encode a decoded image as a full-color sixel escape sequence.
 *
 * Transparent pixels (alpha below {@link ALPHA_THRESHOLD}) are left undrawn so
 * the image floats on the terminal background. Returns `undefined` when the
 * image has no drawable (opaque) pixels.
 *
 * @param img - Decoded RGBA image.
 * @param maxWidth - Cap on rendered pixel width; wider images are downscaled.
 *   Omit to use the default ceiling.
 * @param preserveDimensions - Preserve explicitly supplied dimensions above the
 *   default ceilings. Callers must bound image dimensions first.
 */
export function encodeImageToSixel(
  img: DecodedImage,
  maxWidth?: number,
  preserveDimensions = false
): string | undefined {
  const effectiveMaxWidth = preserveDimensions
    ? (maxWidth ?? DEFAULT_MAX_WIDTH)
    : Math.min(maxWidth ?? DEFAULT_MAX_WIDTH, DEFAULT_MAX_WIDTH);
  const scaled = downscale(
    img,
    effectiveMaxWidth,
    preserveDimensions ? img.height : DEFAULT_MAX_HEIGHT
  );
  const palette = buildPalette(scaled, PALETTE_SIZE);
  if (palette.length === 0) {
    return;
  }

  const { width, height } = scaled;
  // Per-pixel palette index, or -1 for transparent (undrawn).
  const indices = new Int32Array(width * height).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(scaled, x, y);
      if (a >= ALPHA_THRESHOLD) {
        indices[y * width + x] = nearestPaletteIndex(palette, r, g, b);
      }
    }
  }
  const plane: IndexedPlane = { indices, width, height };

  // DCS: P1=0 aspect, P2=1 (unpainted = transparent), P3=0 grid; then raster
  // attributes "1;1;W;H so the terminal reserves the right pixel box.
  let out = `\x1bP0;1;0q"1;1;${width};${height}`;
  palette.forEach(([r, g, b], i) => {
    out += `#${i};2;${to100(r)};${to100(g)};${to100(b)}`;
  });

  const totalBands = Math.ceil(height / 6);
  for (let band = 0; band < totalBands; band++) {
    const y0 = band * 6;
    out += colorsInBand(plane, y0)
      .map((c) => encodeColorBand(plane, y0, c))
      .join("$");
    if (band < totalBands - 1) {
      out += "-";
    }
  }

  out += "\x1b\\"; // String Terminator
  return out;
}

/**
 * Convenience: decode image bytes and encode them as a sixel string in one
 * step. Returns `undefined` when the format is unsupported, the bytes fail to
 * decode, or the image has nothing drawable.
 *
 * @param body - Raw image bytes.
 * @param contentType - Optional HTTP Content-Type, used as a decode-format hint.
 * @param maxWidth - Cap on rendered pixel width (clamped to
 *   {@link DEFAULT_MAX_WIDTH}). Omit to use the default ceiling.
 */
export function imageBytesToSixel(
  body: Uint8Array,
  contentType?: string | null,
  maxWidth?: number
): string | undefined {
  const format = detectImageFormat(body, contentType);
  if (!format) {
    return;
  }
  const decoded = decodeImage(body, format);
  if (!decoded) {
    return;
  }
  return encodeImageToSixel(decoded, maxWidth);
}
