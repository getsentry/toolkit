/**
 * Snapshot image collection for `snapshots upload`.
 *
 * Walks a directory for PNG/JPEG screenshots (skipping hidden files), reads each
 * image's dimensions (header-only, via `image-size`) and SHA-256, and loads any
 * companion `<image>.json` sidecar metadata. Mirrors the legacy Rust
 * `collect_images` / `validate_image_sizes` behaviour.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ValidationError } from "../errors.js";
import { logger } from "../logger.js";
import { walkFiles } from "../scan/walker.js";

const log = logger.withTag("snapshots.images");

/** Matches a file extension (for deriving the sidecar `.json` path). */
const FILE_EXTENSION = /\.[^./\\]+$/;

/** Image extensions considered snapshot images (without a leading dot). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
]);

/** Same extensions in the walker's `.ext` (lowercased, dotted) form. */
const WALK_EXTENSIONS: ReadonlySet<string> = new Set(
  [...IMAGE_EXTENSIONS].map((ext) => `.${ext}`)
);

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8]);

/** Read dimensions from a PNG header, or return undefined for another format. */
function readPngDimensions(
  content: Buffer
): { width: number; height: number } | undefined {
  if (
    content.length >= 24 &&
    content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
    content.toString("ascii", 12, 16) === "IHDR"
  ) {
    const width = content.readUInt32BE(16);
    const height = content.readUInt32BE(20);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
}

/** Return whether a JPEG marker contains a baseline or progressive frame. */
function isJpegFrameMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

/** Read a JPEG segment and return dimensions when it contains a frame. */
function readJpegSegment(
  content: Buffer,
  offset: number,
  marker: number
): { width: number; height: number } | undefined {
  const segmentLength = content.readUInt16BE(offset);
  if (segmentLength < 2 || offset + segmentLength > content.length) {
    throw new Error("Invalid JPEG segment");
  }
  if (isJpegFrameMarker(marker) && segmentLength >= 7) {
    const height = content.readUInt16BE(offset + 3);
    const width = content.readUInt16BE(offset + 5);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  return;
}

/** Read dimensions from a JPEG header, or return undefined for another format. */
function readJpegDimensions(
  content: Buffer
): { width: number; height: number } | undefined {
  if (content.length < 4 || !content.subarray(0, 2).equals(JPEG_SIGNATURE)) {
    return;
  }
  let offset = 2;
  while (offset + 4 <= content.length) {
    if (content[offset] !== 0xff) {
      throw new Error("Invalid JPEG marker");
    }
    const marker = content[offset + 1];
    if (marker === undefined) {
      throw new Error("Invalid JPEG marker");
    }
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    if (marker === 0xda) {
      throw new Error("JPEG dimensions not found");
    }
    const dimensions = readJpegSegment(content, offset, marker);
    if (dimensions) {
      return dimensions;
    }
    const segmentLength = content.readUInt16BE(offset);
    offset += segmentLength;
  }
  return;
}

/** Read dimensions from the PNG/JPEG headers accepted by snapshot uploads. */
function readImageDimensions(content: Buffer): {
  width: number;
  height: number;
} {
  const dimensions = readPngDimensions(content) ?? readJpegDimensions(content);
  if (dimensions) {
    return dimensions;
  }
  throw new Error("Unsupported or malformed image");
}

/** Maximum pixels (width × height) allowed per image. */
export const MAX_PIXELS_PER_IMAGE = 40_000_000;

/** A discovered snapshot image with its metadata. */
export type CollectedImage = {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the scan root, as a forward-slash URL key. */
  relativePath: string;
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** SHA-256 hex digest of the file's bytes. */
  hash: string;
  /** Parsed companion `<image>.json` sidecar metadata (empty if none). */
  sidecar: Record<string, unknown>;
};

/** Normalize a filesystem-relative path to a forward-slash URL key. */
export function pathAsUrl(relativePath: string): string {
  return relativePath.replaceAll("\\", "/");
}

/** Read and parse an image's `<image>.json` sidecar metadata, if present. */
async function readSidecarMetadata(
  imagePath: string
): Promise<Record<string, unknown>> {
  const sidecarPath = imagePath.replace(FILE_EXTENSION, ".json");
  if (sidecarPath === imagePath) {
    return {};
  }
  try {
    const parsed = JSON.parse(await readFile(sidecarPath, "utf8"));
    // Only a JSON object is usable metadata; arrays/scalars are ignored (as the
    // legacy CLI does, deserializing into a map and dropping non-objects).
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err) {
    // Missing sidecars are expected; malformed ones are ignored (matching the
    // legacy CLI, which warns and drops them rather than failing the upload).
    log.debug(`No usable sidecar for ${imagePath}`, err);
    return {};
  }
}

/**
 * Collect snapshot images under `dir`.
 *
 * Reads each file once (for dimensions + hash) and does not retain its bytes.
 * Images whose dimensions cannot be read are skipped with a warning, matching
 * the legacy CLI.
 *
 * @param dir - Directory to scan.
 * @returns The collected images (unsorted).
 */
export async function collectImages(dir: string): Promise<CollectedImage[]> {
  const images: CollectedImage[] = [];
  for await (const entry of walkFiles({
    cwd: dir,
    extensions: WALK_EXTENSIONS,
    hidden: false,
    followSymlinks: true,
    respectGitignore: false,
    alwaysSkipDirs: [],
    maxFileSize: Number.POSITIVE_INFINITY,
    classifyBinary: false,
  })) {
    const content = await readFile(entry.absolutePath);
    let width: number | undefined;
    let height: number | undefined;
    try {
      const size = readImageDimensions(content);
      width = size.width;
      height = size.height;
    } catch (err) {
      log.warn(`Could not read dimensions from ${entry.relativePath}: ${err}`);
      continue;
    }
    if (!(width && height)) {
      log.warn(`Could not read dimensions from ${entry.relativePath}`);
      continue;
    }

    const hash = createHash("sha256").update(content).digest("hex");
    const sidecar = await readSidecarMetadata(entry.absolutePath);
    images.push({
      path: entry.absolutePath,
      relativePath: pathAsUrl(entry.relativePath),
      width,
      height,
      hash,
      sidecar,
    });
  }
  return images;
}

/**
 * Validate that no image exceeds {@link MAX_PIXELS_PER_IMAGE}.
 *
 * @throws {ValidationError} Listing every violating image.
 */
export function validateImageSizes(images: CollectedImage[]): void {
  const violations = images
    .filter((img) => img.width * img.height > MAX_PIXELS_PER_IMAGE)
    .map(
      (img) =>
        `  ${img.relativePath} (${img.width}x${img.height} = ${
          img.width * img.height
        } pixels)`
    );
  if (violations.length > 0) {
    throw new ValidationError(
      `The following images exceed the maximum pixel limit of ${MAX_PIXELS_PER_IMAGE}:\n${violations.join(
        "\n"
      )}`,
      "path"
    );
  }
}

/** Split a string on `separator`, trimming and dropping empty entries. */
export function splitAndTrim(input: string, separator: string): string[] {
  return input
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Normalize image name entries: strip a leading `./` and `\`→`/`. */
export function normalizeImageNames(names: string[]): string[] {
  return names.map((s) =>
    (s.startsWith("./") ? s.slice(2) : s).replaceAll("\\", "/")
  );
}
