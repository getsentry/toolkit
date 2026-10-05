/**
 * Runtime image → kitty graphics encoding.
 *
 * Turns a decoded raster image (PNG or JPEG) into a kitty graphics protocol
 * escape sequence for inline display on kitty-capable terminals. This is the
 * kitty companion to {@link ./sixel-image.ts}: newer terminals (kitty, WezTerm,
 * Ghostty, recent Konsole) prefer the kitty protocol, which transmits full RGBA
 * pixels directly — no palette quantization and native per-pixel alpha.
 *
 * Used by `sentry api` to render image attachments (screenshots, etc.) inline
 * instead of dumping raw bytes into an interactive terminal, taking precedence
 * over sixel when the terminal advertises kitty support.
 *
 * Protocol notes (see https://sw.kovidgoyal.net/kitty/graphics-protocol/):
 *   - Data is transmitted with the APC introducer `ESC _ G <keys> ; <payload>`
 *     terminated by the String Terminator `ESC \`.
 *   - `a=T` transmits and immediately displays; `f=32` declares 32-bit RGBA;
 *     `s`/`v` give the pixel width/height of the raw buffer.
 *   - The base64 payload is split into <= 4096-byte chunks; every chunk but the
 *     last sets `m=1` (more follows), the final one sets `m=0`.
 */

import {
  DEFAULT_MAX_HEIGHT,
  DEFAULT_MAX_WIDTH,
  type DecodedImage,
  decodeImage,
  detectImageFormat,
  downscale,
} from "./sixel-image.js";

/** Max base64 payload bytes per kitty transmission chunk (protocol limit). */
const CHUNK_SIZE = 4096;

/**
 * Encode a decoded image as a kitty graphics escape sequence.
 *
 * The full RGBA buffer is transmitted directly, so transparency and color are
 * preserved exactly (unlike the sixel path, which quantizes to a palette).
 * Returns `undefined` when the image has no pixels.
 *
 * @param img - Decoded RGBA image.
 * @param maxWidth - Cap on rendered pixel width; wider images are downscaled.
 *   Omit to use the default ceiling.
 * @param preserveDimensions - Preserve explicitly supplied dimensions above the
 *   default ceilings. Callers must bound image dimensions first.
 */
export function encodeImageToKitty(
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
  const { width, height } = scaled;
  if (width <= 0 || height <= 0) {
    return;
  }

  const payload = Buffer.from(
    scaled.data.buffer,
    scaled.data.byteOffset,
    width * height * 4
  ).toString("base64");

  // a=T transmit+display, f=32 RGBA, s/v pixel dimensions of the raw buffer.
  const header = `a=T,f=32,s=${width},v=${height}`;
  let out = "";
  for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
    const chunk = payload.slice(offset, offset + CHUNK_SIZE);
    const more = offset + CHUNK_SIZE < payload.length ? 1 : 0;
    // The metadata keys ride the first chunk; later chunks only carry `m`.
    const keys = offset === 0 ? `${header},m=${more}` : `m=${more}`;
    out += `\x1b_G${keys};${chunk}\x1b\\`;
  }
  return out;
}

/**
 * Convenience: decode image bytes and encode them as a kitty graphics string in
 * one step. Returns `undefined` when the format is unsupported, the bytes fail
 * to decode, or the image has no pixels.
 *
 * @param body - Raw image bytes.
 * @param contentType - Optional HTTP Content-Type, used as a decode-format hint.
 * @param maxWidth - Cap on rendered pixel width (clamped to
 *   {@link DEFAULT_MAX_WIDTH}). Omit to use the default ceiling.
 */
export function imageBytesToKitty(
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
  return encodeImageToKitty(decoded, maxWidth);
}
