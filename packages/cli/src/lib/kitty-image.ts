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
 *
 * Inside tmux the sequences are wrapped in tmux's DCS passthrough so they reach
 * the outer terminal, and the image is drawn with Unicode placeholders
 * (`U=1`): tmux doesn't understand kitty images, but it does track placeholder
 * text, so the image keeps its cells, scrolls with the pane, and survives
 * redraws instead of being overwritten.
 */

import { randomInt } from "node:crypto";

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

/** Unicode placeholder that kitty terminals replace with a cell of an image. */
const PLACEHOLDER = String.fromCodePoint(0x10_ee_ee);

/**
 * Combining marks that encode a placeholder's row (and column) index: entry `n`
 * means index `n`. Copied verbatim from kitty's `gen/rowcolumn-diacritics.txt`;
 * the order is part of the protocol, so it must not be edited or sorted.
 */
const ROW_COLUMN_DIACRITICS = [
  0x03_05, 0x03_0d, 0x03_0e, 0x03_10, 0x03_12, 0x03_3d, 0x03_3e, 0x03_3f,
  0x03_46, 0x03_4a, 0x03_4b, 0x03_4c, 0x03_50, 0x03_51, 0x03_52, 0x03_57,
  0x03_5b, 0x03_63, 0x03_64, 0x03_65, 0x03_66, 0x03_67, 0x03_68, 0x03_69,
  0x03_6a, 0x03_6b, 0x03_6c, 0x03_6d, 0x03_6e, 0x03_6f, 0x04_83, 0x04_84,
  0x04_85, 0x04_86, 0x04_87, 0x05_92, 0x05_93, 0x05_94, 0x05_95, 0x05_97,
  0x05_98, 0x05_99, 0x05_9c, 0x05_9d, 0x05_9e, 0x05_9f, 0x05_a0, 0x05_a1,
  0x05_a8, 0x05_a9, 0x05_ab, 0x05_ac, 0x05_af, 0x05_c4, 0x06_10, 0x06_11,
  0x06_12, 0x06_13, 0x06_14, 0x06_15, 0x06_16, 0x06_17, 0x06_57, 0x06_58,
  0x06_59, 0x06_5a, 0x06_5b, 0x06_5d, 0x06_5e, 0x06_d6, 0x06_d7, 0x06_d8,
  0x06_d9, 0x06_da, 0x06_db, 0x06_dc, 0x06_df, 0x06_e0, 0x06_e1, 0x06_e2,
  0x06_e4, 0x06_e7, 0x06_e8, 0x06_eb, 0x06_ec, 0x07_30, 0x07_32, 0x07_33,
  0x07_35, 0x07_36, 0x07_3a, 0x07_3d, 0x07_3f, 0x07_40, 0x07_41, 0x07_43,
  0x07_45, 0x07_47, 0x07_49, 0x07_4a, 0x07_eb, 0x07_ec, 0x07_ed, 0x07_ee,
  0x07_ef, 0x07_f0, 0x07_f1, 0x07_f3, 0x08_16, 0x08_17, 0x08_18, 0x08_19,
  0x08_1b, 0x08_1c, 0x08_1d, 0x08_1e, 0x08_1f, 0x08_20, 0x08_21, 0x08_22,
  0x08_23, 0x08_25, 0x08_26, 0x08_27, 0x08_29, 0x08_2a, 0x08_2b, 0x08_2c,
  0x08_2d, 0x09_51, 0x09_53, 0x09_54, 0x0f_82, 0x0f_83, 0x0f_86, 0x0f_87,
  0x13_5d, 0x13_5e, 0x13_5f, 0x17_dd, 0x19_3a, 0x1a_17, 0x1a_75, 0x1a_76,
  0x1a_77, 0x1a_78, 0x1a_79, 0x1a_7a, 0x1a_7b, 0x1a_7c, 0x1b_6b, 0x1b_6d,
  0x1b_6e, 0x1b_6f, 0x1b_70, 0x1b_71, 0x1b_72, 0x1b_73, 0x1c_d0, 0x1c_d1,
  0x1c_d2, 0x1c_da, 0x1c_db, 0x1c_e0, 0x1d_c0, 0x1d_c1, 0x1d_c3, 0x1d_c4,
  0x1d_c5, 0x1d_c6, 0x1d_c7, 0x1d_c8, 0x1d_c9, 0x1d_cb, 0x1d_cc, 0x1d_d1,
  0x1d_d2, 0x1d_d3, 0x1d_d4, 0x1d_d5, 0x1d_d6, 0x1d_d7, 0x1d_d8, 0x1d_d9,
  0x1d_da, 0x1d_db, 0x1d_dc, 0x1d_dd, 0x1d_de, 0x1d_df, 0x1d_e0, 0x1d_e1,
  0x1d_e2, 0x1d_e3, 0x1d_e4, 0x1d_e5, 0x1d_e6, 0x1d_fe, 0x20_d0, 0x20_d1,
  0x20_d4, 0x20_d5, 0x20_d6, 0x20_d7, 0x20_db, 0x20_dc, 0x20_e1, 0x20_e7,
  0x20_e9, 0x20_f0, 0x2c_ef, 0x2c_f0, 0x2c_f1, 0x2d_e0, 0x2d_e1, 0x2d_e2,
  0x2d_e3, 0x2d_e4, 0x2d_e5, 0x2d_e6, 0x2d_e7, 0x2d_e8, 0x2d_e9, 0x2d_ea,
  0x2d_eb, 0x2d_ec, 0x2d_ed, 0x2d_ee, 0x2d_ef, 0x2d_f0, 0x2d_f1, 0x2d_f2,
  0x2d_f3, 0x2d_f4, 0x2d_f5, 0x2d_f6, 0x2d_f7, 0x2d_f8, 0x2d_f9, 0x2d_fa,
  0x2d_fb, 0x2d_fc, 0x2d_fd, 0x2d_fe, 0x2d_ff, 0xa6_6f, 0xa6_7c, 0xa6_7d,
  0xa6_f0, 0xa6_f1, 0xa8_e0, 0xa8_e1, 0xa8_e2, 0xa8_e3, 0xa8_e4, 0xa8_e5,
  0xa8_e6, 0xa8_e7, 0xa8_e8, 0xa8_e9, 0xa8_ea, 0xa8_eb, 0xa8_ec, 0xa8_ed,
  0xa8_ee, 0xa8_ef, 0xa8_f0, 0xa8_f1, 0xaa_b0, 0xaa_b2, 0xaa_b3, 0xaa_b7,
  0xaa_b8, 0xaa_be, 0xaa_bf, 0xaa_c1, 0xfe_20, 0xfe_21, 0xfe_22, 0xfe_23,
  0xfe_24, 0xfe_25, 0xfe_26, 0x1_0a_0f, 0x1_0a_38, 0x1_d1_85, 0x1_d1_86,
  0x1_d1_87, 0x1_d1_88, 0x1_d1_89, 0x1_d1_aa, 0x1_d1_ab, 0x1_d1_ac, 0x1_d1_ad,
  0x1_d2_42, 0x1_d2_43, 0x1_d2_44,
];

/** Largest kitty image id that fits the 24-bit foreground color encoding. */
const MAX_PLACEHOLDER_IMAGE_ID = 0xff_ff_ff;

/**
 * Cell geometry for drawing a kitty image inside tmux with Unicode
 * placeholders. The image is scaled by the terminal to fill exactly the
 * computed cell box, so these only need to be close to the real cell size.
 */
export type TmuxKittyPlacement = {
  /** Character-cell width in pixels. */
  cellWidth: number;
  /** Character-cell height in pixels. */
  cellHeight: number;
  /** Most terminal columns the image may span; wider images are scaled down. */
  maxColumns: number;
};

/**
 * Wrap an escape sequence in tmux's DCS passthrough (`ESC P tmux; … ESC \`),
 * doubling every inner ESC, so tmux forwards it untouched to the outer
 * terminal. tmux drops the sequence unless `allow-passthrough` is enabled.
 */
export function wrapTmuxPassthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

/**
 * Split a base64 payload into kitty APC chunks. `keys` ride the first chunk;
 * later chunks only carry `m` (1 = more follows, 0 = last).
 */
function kittyChunks(keys: string, payload: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
    const chunk = payload.slice(offset, offset + CHUNK_SIZE);
    const more = offset + CHUNK_SIZE < payload.length ? 1 : 0;
    const chunkKeys = offset === 0 ? `${keys},m=${more}` : `m=${more}`;
    chunks.push(`\x1b_G${chunkKeys};${chunk}\x1b\\`);
  }
  return chunks;
}

/**
 * Draw a transmitted image inside tmux: send it through passthrough as a
 * virtual placement (`U=1`) sized to a cell box, then print one line of
 * placeholder cells per image row. The image id is carried in the 24-bit
 * foreground color; each line's first cell names its row and column 0 with
 * diacritics and the remaining cells continue that row implicitly.
 *
 * Returns `undefined` when the image needs more rows than the diacritics
 * table can address.
 */
function tmuxPlaceholderImage(
  keys: string,
  payload: string,
  size: { width: number; height: number },
  placement: TmuxKittyPlacement,
): string | undefined {
  const columns = Math.max(
    1,
    Math.min(placement.maxColumns, Math.ceil(size.width / placement.cellWidth)),
  );
  const rows = Math.max(
    1,
    Math.ceil(
      (size.height * columns * placement.cellWidth) /
        (size.width * placement.cellHeight),
    ),
  );
  if (rows > ROW_COLUMN_DIACRITICS.length) {
    return;
  }
  // A random id keeps this image from replacing another one still on screen.
  const id = randomInt(1, MAX_PLACEHOLDER_IMAGE_ID + 1);
  // q=2 silences the terminal's OK/error reply, which would otherwise be
  // typed into the shell because an explicit image id was given.
  const transmit = kittyChunks(
    `a=T,U=1,q=2,i=${id},c=${columns},r=${rows},${keys}`,
    payload,
  )
    .map(wrapTmuxPassthrough)
    .join("");
  const color = `\x1b[38;2;${Math.floor(id / 65_536)};${Math.floor(id / 256) % 256};${id % 256}m`;
  const column0 = String.fromCodePoint(ROW_COLUMN_DIACRITICS[0] as number);
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    const rowMark = String.fromCodePoint(ROW_COLUMN_DIACRITICS[row] as number);
    lines.push(
      `${color}${PLACEHOLDER}${rowMark}${column0}${PLACEHOLDER.repeat(columns - 1)}\x1b[39m`,
    );
  }
  return transmit + lines.join("\n");
}

/**
 * Build the escape string that displays a kitty image from an already-encoded
 * base64 payload.
 *
 * Without `tmux`, the image is transmitted and placed at the cursor (`a=T`).
 * With `tmux`, it is routed through passthrough and drawn with Unicode
 * placeholders sized to the given cell geometry.
 *
 * @param keys - Format keys describing the payload (e.g. `f=100` for PNG, or
 *   `f=32,s=W,v=H` for raw RGBA).
 * @param payload - Base64-encoded image data.
 * @param size - Image size in pixels, used to size the tmux cell box.
 * @param tmux - Cell geometry when running inside tmux with passthrough.
 */
export function kittyImageSequence(
  keys: string,
  payload: string,
  size: { width: number; height: number },
  tmux?: TmuxKittyPlacement,
): string | undefined {
  if (payload.length === 0 || size.width <= 0 || size.height <= 0) {
    return;
  }
  if (tmux) {
    return tmuxPlaceholderImage(keys, payload, size, tmux);
  }
  return kittyChunks(`a=T,${keys}`, payload).join("");
}

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
 * @param tmux - Cell geometry when running inside tmux with passthrough; see
 *   {@link kittyImageSequence}.
 */
export function encodeImageToKitty(
  img: DecodedImage,
  maxWidth?: number,
  preserveDimensions = false,
  tmux?: TmuxKittyPlacement,
): string | undefined {
  const effectiveMaxWidth = preserveDimensions
    ? (maxWidth ?? DEFAULT_MAX_WIDTH)
    : Math.min(maxWidth ?? DEFAULT_MAX_WIDTH, DEFAULT_MAX_WIDTH);
  const scaled = downscale(
    img,
    effectiveMaxWidth,
    preserveDimensions ? img.height : DEFAULT_MAX_HEIGHT,
  );
  const { width, height } = scaled;
  if (width <= 0 || height <= 0) {
    return;
  }

  const payload = Buffer.from(
    scaled.data.buffer,
    scaled.data.byteOffset,
    width * height * 4,
  ).toString("base64");

  // f=32 RGBA, s/v pixel dimensions of the raw buffer.
  return kittyImageSequence(
    `f=32,s=${width},v=${height}`,
    payload,
    { width, height },
    tmux,
  );
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
 * @param tmux - Cell geometry when running inside tmux with passthrough.
 */
export function imageBytesToKitty(
  body: Uint8Array,
  contentType?: string | null,
  maxWidth?: number,
  tmux?: TmuxKittyPlacement,
): string | undefined {
  const format = detectImageFormat(body, contentType);
  if (!format) {
    return;
  }
  const decoded = decodeImage(body, format);
  if (!decoded) {
    return;
  }
  return encodeImageToKitty(decoded, maxWidth, false, tmux);
}
