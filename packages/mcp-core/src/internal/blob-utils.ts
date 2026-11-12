import { decode as decodePng, encode as encodePng } from "fast-png";
import type { DecodedPng } from "fast-png";
import jpeg from "jpeg-js";

export async function blobToBase64(blob: Blob): Promise<string> {
  return Buffer.from(await blob.arrayBuffer()).toString("base64");
}

/**
 * Base64-encode raw bytes without an intermediate copy.
 *
 * `Buffer.from(bytes.buffer, …)` views the existing memory instead of copying
 * it. Prefer this over a `Blob` round-trip when you already hold a `Uint8Array`.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64",
  );
}

export interface ImagePreviewOptions {
  maxDimension?: number;
  jpegQuality?: number;
}

export interface ImagePreviewResult {
  blob: Blob;
  contentType: string;
  width: number;
  height: number;
  resized: boolean;
}

const DEFAULT_MAX_PREVIEW_DIMENSION = 1024;
const DEFAULT_JPEG_QUALITY = 80;
const MAX_PREVIEW_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_PIXELS = 12_000_000;
const MAX_JPEG_DECODE_MEMORY_MB = 64;

const MAGIC_SIGNATURES: { mime: string; offsets: [number, number][] }[] = [
  {
    mime: "image/png",
    offsets: [
      [0, 0x89],
      [1, 0x50],
      [2, 0x4e],
      [3, 0x47],
    ],
  },
  {
    mime: "image/jpeg",
    offsets: [
      [0, 0xff],
      [1, 0xd8],
      [2, 0xff],
    ],
  },
  {
    mime: "image/gif",
    offsets: [
      [0, 0x47],
      [1, 0x49],
      [2, 0x46],
      [3, 0x38],
    ],
  },
  {
    mime: "image/webp",
    offsets: [
      [0, 0x52],
      [1, 0x49],
      [2, 0x46],
      [3, 0x46],
      [8, 0x57],
      [9, 0x45],
      [10, 0x42],
      [11, 0x50],
    ],
  },
];

export async function detectImageMimeType(blob: Blob): Promise<string | null> {
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  for (const { mime, offsets } of MAGIC_SIGNATURES) {
    if (offsets.every(([offset, byte]) => header[offset] === byte)) {
      return mime;
    }
  }
  return null;
}

export async function createImagePreview(
  blob: Blob,
  contentType: string,
  options: ImagePreviewOptions = {},
): Promise<ImagePreviewResult | null> {
  if (blob.size > MAX_PREVIEW_SOURCE_BYTES) {
    return null;
  }

  const normalizedContentType = normalizeImageContentType(contentType);
  const codec = PREVIEW_CODECS[normalizedContentType];
  if (!codec) {
    return null;
  }

  const maxDimension = options.maxDimension ?? DEFAULT_MAX_PREVIEW_DIMENSION;
  const jpegQuality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  const sourceBytes = new Uint8Array(await blob.arrayBuffer());
  const dimensions = codec.readDimensions(sourceBytes);

  if (!dimensions || !isWithinPreviewPixelLimit(dimensions)) {
    return null;
  }

  if (Math.max(dimensions.width, dimensions.height) <= maxDimension) {
    return {
      blob,
      contentType: normalizedContentType,
      width: dimensions.width,
      height: dimensions.height,
      resized: false,
    };
  }

  let rgba: RgbaImage | null;
  try {
    rgba = codec.decode(sourceBytes);
  } catch {
    return null;
  }
  if (!rgba) {
    return null;
  }

  const resized = resizeRgbaToMaxDimension(rgba, maxDimension);
  let encoded: Uint8Array;
  try {
    encoded = codec.encode(resized, { jpegQuality });
  } catch {
    return null;
  }
  return {
    blob: new Blob([encoded], { type: codec.contentType }),
    contentType: codec.contentType,
    width: resized.width,
    height: resized.height,
    resized: true,
  };
}

interface PreviewCodec {
  contentType: string;
  readDimensions: (bytes: Uint8Array) => ImageDimensions | null;
  decode: (bytes: Uint8Array) => RgbaImage | null;
  encode: (image: RgbaImage, options: { jpegQuality: number }) => Uint8Array;
}

const PREVIEW_CODECS: Partial<Record<string, PreviewCodec>> = {
  "image/png": {
    contentType: "image/png",
    readDimensions: readPngDimensions,
    decode: (bytes) => pngToRgba(decodePng(bytes)),
    encode: (image) =>
      encodePng({
        width: image.width,
        height: image.height,
        data: image.data,
        depth: 8,
        channels: 4,
      }),
  },
  "image/jpeg": {
    contentType: "image/jpeg",
    readDimensions: readJpegDimensions,
    decode: (bytes) => {
      const image = jpeg.decode(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        maxMemoryUsageInMB: MAX_JPEG_DECODE_MEMORY_MB,
      });
      return { width: image.width, height: image.height, data: image.data };
    },
    encode: (image, { jpegQuality }) => jpeg.encode(image, jpegQuality).data,
  },
};

function normalizeImageContentType(contentType: string): string {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

interface ImageDimensions {
  width: number;
  height: number;
}

interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

function isWithinPreviewPixelLimit(
  dimensions: ImageDimensions | null,
): boolean {
  if (!dimensions) {
    return false;
  }

  return dimensions.width * dimensions.height <= MAX_PREVIEW_PIXELS;
}

function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24 || !hasPngMagicBytes(bytes)) {
    return null;
  }

  return {
    width: readUint32BigEndian(bytes, 16),
    height: readUint32BigEndian(bytes, 20),
  };
}

function hasPngMagicBytes(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < bytes.length) {
    while (bytes[offset] === 0xff) {
      offset++;
    }

    const marker = bytes.at(offset);
    offset++;

    if (marker === undefined || marker === 0xd9 || marker === 0xda) {
      return null;
    }

    if (offset + 2 > bytes.length) {
      return null;
    }

    const segmentLength = readUint16BigEndian(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return null;
    }

    if (isJpegStartOfFrameMarker(marker)) {
      if (segmentLength < 7) {
        return null;
      }

      return {
        height: readUint16BigEndian(bytes, offset + 3),
        width: readUint16BigEndian(bytes, offset + 5),
      };
    }

    offset += segmentLength;
  }

  return null;
}

function isJpegStartOfFrameMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    (((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0))
  );
}

function pngToRgba(image: DecodedPng): RgbaImage | null {
  const { width, height, channels } = image;
  if (channels < 1 || channels > 4) {
    return null;
  }
  if (!isSupportedPngData(image.data, image.depth)) {
    return null;
  }

  // Fast path: 8-bit RGBA is already in the layout we need.
  if (
    image.depth === 8 &&
    channels === 4 &&
    !(image.data instanceof Uint16Array)
  ) {
    return { width, height, data: image.data };
  }

  const rgba = new Uint8Array(width * height * 4);
  const pixelCount = width * height;

  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const source = pixel * channels;
    const target = pixel * 4;

    if (channels === 1 || channels === 2) {
      const gray = readPngSample(image, source);
      rgba[target] = gray;
      rgba[target + 1] = gray;
      rgba[target + 2] = gray;
      rgba[target + 3] =
        channels === 2 ? readPngSample(image, source + 1) : 255;
      continue;
    }

    rgba[target] = readPngSample(image, source);
    rgba[target + 1] = readPngSample(image, source + 1);
    rgba[target + 2] = readPngSample(image, source + 2);
    rgba[target + 3] = channels === 4 ? readPngSample(image, source + 3) : 255;
  }

  return { width, height, data: rgba };
}

function isSupportedPngData(
  data: DecodedPng["data"],
  depth: number,
): data is Uint8Array | Uint8ClampedArray | Uint16Array {
  if (depth === 8) {
    return data instanceof Uint8Array || data instanceof Uint8ClampedArray;
  }
  if (depth === 16) {
    return data instanceof Uint16Array;
  }
  return false;
}

function readPngSample(image: DecodedPng, index: number): number {
  const value = image.data[index] ?? 0;
  if (image.depth === 16) {
    return value >> 8;
  }

  return value;
}

function resizeRgbaToMaxDimension(
  image: RgbaImage,
  maxDimension: number,
): RgbaImage {
  const longestSide = Math.max(image.width, image.height);
  if (longestSide <= maxDimension) {
    return image;
  }

  const scale = maxDimension / longestSide;
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));
  return resizeRgbaNearestNeighbor(image, targetWidth, targetHeight);
}

function resizeRgbaNearestNeighbor(
  image: RgbaImage,
  targetWidth: number,
  targetHeight: number,
): RgbaImage {
  const data = new Uint8Array(targetWidth * targetHeight * 4);
  const xRatio = image.width / targetWidth;
  const yRatio = image.height / targetHeight;

  for (let y = 0; y < targetHeight; y++) {
    const sourceY = Math.min(image.height - 1, Math.floor(y * yRatio));
    for (let x = 0; x < targetWidth; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor(x * xRatio));
      const source = (sourceY * image.width + sourceX) * 4;
      const target = (y * targetWidth + x) * 4;
      data[target] = image.data[source] ?? 0;
      data[target + 1] = image.data[source + 1] ?? 0;
      data[target + 2] = image.data[source + 2] ?? 0;
      data[target + 3] = image.data[source + 3] ?? 255;
    }
  }

  return { width: targetWidth, height: targetHeight, data };
}
