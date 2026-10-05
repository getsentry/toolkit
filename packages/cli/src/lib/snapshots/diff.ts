/**
 * Local snapshot image diffing.
 *
 * Pure-JS perceptual image comparison (no native/WASM deps): `pixelmatch`
 * implements the same YIQ-color-space, anti-aliasing-aware algorithm as the
 * legacy CLI's `odiff`, and `pngjs`/`jpeg-js` decode the inputs. The diff mask
 * is always written as PNG.
 */

import { extname, resolve } from "node:path";
import { decode as decodeJpeg } from "jpeg-js";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { ValidationError } from "../errors.js";
import { walkFiles } from "../scan/walker.js";

/** Image file extensions eligible for diffing (matches the legacy CLI). */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg"] as const;

/** Extension allowlist for {@link walkFiles} (extname form, with the dot). */
const IMAGE_EXT_SET: ReadonlySet<string> = new Set(
  IMAGE_EXTENSIONS.map((ext) => `.${ext}`)
);

/**
 * Recursively collect image files under a directory.
 *
 * @param dir - Directory to walk.
 * @returns POSIX-normalized paths relative to `dir`, sorted.
 */
export async function collectImageFiles(dir: string): Promise<string[]> {
  const relativePaths: string[] = [];
  for await (const entry of walkFiles({
    cwd: resolve(dir),
    extensions: IMAGE_EXT_SET,
    respectGitignore: false,
    alwaysSkipDirs: [],
    maxFileSize: Number.POSITIVE_INFINITY,
    followSymlinks: true,
    classifyBinary: false,
  })) {
    relativePaths.push(entry.relativePath);
  }
  return relativePaths.sort();
}

/** Image files partitioned by presence in the base vs head directories. */
export type CategorizedImages = {
  /** Present in both directories. */
  matched: string[];
  /** Present only in head. */
  added: string[];
  /** Present only in base (empty when `selective`). */
  removed: string[];
  /** Base-only images treated as skipped instead of removed (`selective`). */
  skipped: string[];
};

/**
 * Partition base/head image paths into matched/added/removed/skipped.
 *
 * @param selective - When true, base-only images are `skipped` (not `removed`),
 *   so missing head images aren't reported as removals.
 */
export function categorizeImages(
  base: string[],
  head: string[],
  selective: boolean
): CategorizedImages {
  const baseSet = new Set(base);
  const headSet = new Set(head);
  const matched = base.filter((p) => headSet.has(p));
  const added = head.filter((p) => !baseSet.has(p));
  const baseOnly = base.filter((p) => !headSet.has(p));
  return selective
    ? { matched, added, removed: [], skipped: baseOnly }
    : { matched, added, removed: baseOnly, skipped: [] };
}

/** A decoded image as raw RGBA pixels. */
type DecodedImage = { width: number; height: number; data: Uint8Array };

/** Options controlling a single image comparison. */
export type DiffOptions = {
  /** Per-pixel color-difference sensitivity (0..1); matches odiff's threshold. */
  threshold: number;
  /** When true, anti-aliased pixels are NOT counted as differences. */
  antialiasing: boolean;
};

/**
 * Result of comparing two images:
 * - `match`: pixel-identical within the threshold.
 * - `layout`: dimensions differ (no per-pixel diff possible).
 * - `changed`: differing pixels, with a PNG diff mask.
 */
export type ImageDiff =
  | { kind: "match" }
  | { kind: "layout" }
  | {
      kind: "changed";
      /** Number of differing pixels. */
      diffCount: number;
      /** Percentage of differing pixels (0–100), matching the legacy odiff output. */
      diffPercentage: number;
      mask: Buffer;
    };

/** Decode PNG/JPEG bytes to RGBA. */
function decodeImage(buffer: Buffer, path: string): DecodedImage {
  const ext = extname(path).slice(1).toLowerCase();
  if (ext === "png") {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (ext === "jpg" || ext === "jpeg") {
    const jpg = decodeJpeg(buffer, { useTArray: true, formatAsRGBA: true });
    return { width: jpg.width, height: jpg.height, data: jpg.data };
  }
  throw new ValidationError(`Unsupported image format: ${path}`, "image");
}

/**
 * Compare two already-read image buffers.
 *
 * @param baseBuf - Baseline image bytes.
 * @param headBuf - Head image bytes.
 * @param path - Relative path (used for extension detection + errors).
 * @param opts - Threshold / antialiasing options.
 * @throws {ValidationError} On an unsupported format.
 * @throws On undecodable image data (surfaced by the caller as an error entry).
 */
export function compareImages(
  baseBuf: Buffer,
  headBuf: Buffer,
  path: string,
  opts: DiffOptions
): ImageDiff {
  const base = decodeImage(baseBuf, path);
  const head = decodeImage(headBuf, path);

  if (base.width !== head.width || base.height !== head.height) {
    return { kind: "layout" };
  }

  const { width, height } = base;
  const output = Buffer.alloc(width * height * 4);
  const diffCount = pixelmatch(base.data, head.data, output, width, height, {
    threshold: opts.threshold,
    includeAA: !opts.antialiasing,
    diffMask: true,
  });

  if (diffCount === 0) {
    return { kind: "match" };
  }

  const png = new PNG({ width, height });
  png.data = output;
  return {
    kind: "changed",
    diffCount,
    diffPercentage: (diffCount / (width * height)) * 100,
    mask: PNG.sync.write(png),
  };
}
