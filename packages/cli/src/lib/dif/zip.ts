/**
 * ZIP archive scanning for debug information files.
 *
 * The `debug-files upload` scanner can look inside `.zip` archives for debug
 * files, matching the legacy `sentry-cli` behavior (`try_open_zip` /
 * `walk_difs_zip`). A file is treated as a ZIP only when its extension is
 * `.zip` and its first two bytes are the `PK` local-file-header magic; anything
 * else falls back to normal file handling.
 *
 * Decompression is bounded on three axes to guard against zip bombs and to
 * cap peak memory, since `unzipSync` materializes every accepted entry at once:
 *
 *  1. **Container gate** — the archive is `stat`-ed before being read; a
 *     container whose on-disk (compressed) size already exceeds the total
 *     extraction budget is skipped without ever being buffered.
 *  2. **Per-entry gate** — an entry whose declared uncompressed size exceeds
 *     `maxFileSize` is skipped via fflate's pre-decompression `filter` and
 *     never inflated.
 *  3. **Cumulative gate** — once the running total of accepted uncompressed
 *     bytes would exceed `maxTotalSize`, no further entries are inflated. This
 *     bounds the classic flat zip-bomb (many in-range entries) that a per-entry
 *     gate alone cannot stop.
 *
 * Entries using a compression method fflate cannot inflate (anything other than
 * store/deflate) are skipped rather than extracted: returning `true` for such
 * an entry makes `unzipSync` throw and discards the *entire* archive, taking
 * valid sibling DIFs with it. Nested archives are not recursed (a `.zip` inside
 * a `.zip` is ignored), matching the legacy tool.
 */

import { open, readFile } from "node:fs/promises";
import { type UnzipFileInfo, unzipSync } from "fflate";
import { logger } from "../logger.js";

const log = logger.withTag("dif.zip");

/** Local-file-header signature ("PK\x03\x04") — first two bytes are enough. */
const ZIP_MAGIC_0 = 0x50; // 'P'
const ZIP_MAGIC_1 = 0x4b; // 'K'

/**
 * ZIP compression methods fflate's `unzipSync` can inflate: store (0) and
 * deflate (8). Any other method (LZMA, bzip2, zstd, AES, …) makes `unzipSync`
 * throw, so such entries are filtered out before extraction.
 */
const SUPPORTED_COMPRESSION = new Set([0, 8]);

/**
 * Default cumulative uncompressed-extraction budget per archive, in bytes
 * (2 GiB, mirroring `DEFAULT_MAX_DIF_SIZE`). Because `unzipSync` holds every
 * accepted entry in memory simultaneously, this caps an archive's peak
 * decompression footprint. It also gates the container's own on-disk size: a
 * compressed archive larger than this cannot fit the budget once inflated, so
 * it is skipped rather than buffered. Entries beyond the budget are skipped
 * with a warning; for archives whose legitimate contents exceed it, extract
 * them and scan the directory instead.
 */
export const DEFAULT_MAX_ZIP_TOTAL_SIZE = 2 * 1024 * 1024 * 1024;

/** A debug-file candidate extracted from a ZIP archive. */
export type ZipDifEntry = {
  /**
   * Synthetic display path `"<zipPath>/<entryName>"`. `basename()` of it yields
   * the entry's own base name (the DIF name), and the full string preserves the
   * archive origin in logs and error messages.
   */
  path: string;
  /** Decompressed entry bytes. */
  content: Buffer;
};

/** Result of {@link readZipDifEntries}. */
export type ReadZipResult = {
  /** Decompressed, non-directory entries that passed the size gates. */
  entries: ZipDifEntry[];
  /**
   * Advisory count of entries skipped because their uncompressed size exceeded
   * `maxFileSize`. This is **format-agnostic** — a compressed entry's container
   * format is unknown until it is decompressed, so every oversized entry is
   * counted regardless of `--type`. It is surfaced only via per-entry warnings
   * and must NOT drive the command's exit code or "all files too large"
   * message; that decision uses the on-disk path's format-accurate count (see
   * {@link import("./scan.js").PrepareDifsResult}). The cumulative-budget and
   * container gates are not reflected here (they already warn independently).
   */
  oversizedCount: number;
};

/** Options for {@link readZipDifEntries}. */
export type ReadZipOptions = {
  /**
   * Maximum uncompressed size, in bytes, of a single entry to extract. Entries
   * above this are skipped without decompression. `0` or omitted means no
   * per-entry gate.
   */
  maxFileSize?: number;
  /**
   * Cumulative uncompressed-extraction budget for the whole archive, in bytes,
   * and the maximum on-disk size of the container itself. Defaults to
   * {@link DEFAULT_MAX_ZIP_TOTAL_SIZE}; `0` disables both the cumulative and
   * container gates.
   */
  maxTotalSize?: number;
};

/** Whether a ZIP entry name denotes a directory (trailing slash). */
function isDirectoryEntry(name: string): boolean {
  return name.endsWith("/");
}

/**
 * Cheaply inspect a candidate without reading its body: report whether it
 * begins with the ZIP local-file-header magic and its on-disk size (used by the
 * container gate). A single open serves both the magic peek and the `stat`.
 *
 * @returns `{ isZip, size }`; `isZip` is `false` (and `size` `0`) when the file
 *   cannot be opened or is shorter than the 2-byte magic.
 */
async function peekZipContainer(
  path: string
): Promise<{ isZip: boolean; size: number }> {
  try {
    const fd = await open(path, "r");
    try {
      const { size } = await fd.stat();
      const buf = Buffer.alloc(2);
      const { bytesRead } = await fd.read(buf, 0, 2, 0);
      const isZip =
        bytesRead === 2 && buf[0] === ZIP_MAGIC_0 && buf[1] === ZIP_MAGIC_1;
      return { isZip, size };
    } finally {
      await fd.close();
    }
  } catch (err) {
    log.debug(`Could not read header of ${path}`, err);
    return { isZip: false, size: 0 };
  }
}

/**
 * Open `path` as a ZIP archive and return its candidate debug-file entries.
 *
 * Returns `null` when the file is not a ZIP — its extension is not `.zip` or it
 * lacks the `PK` magic — signalling the caller to handle it as a normal file.
 * A malformed or unreadable archive, or one whose compressed size exceeds the
 * total extraction budget, also yields `null` (logged), so the container is
 * skipped rather than parsed as a debug file.
 *
 * Directory and empty entries are dropped, as are entries using a compression
 * method fflate cannot inflate. Entries whose uncompressed size exceeds
 * `maxFileSize`, or which would push cumulative extraction past `maxTotalSize`,
 * are skipped before decompression. Nested archives are not recursed.
 *
 * @param path - Filesystem path to inspect.
 * @param options - Optional size gates (see {@link ReadZipOptions}).
 * @returns Extracted entries plus oversized telemetry, or `null` when not a ZIP
 *   (or when the container is skipped wholesale).
 */
export async function readZipDifEntries(
  path: string,
  options: ReadZipOptions = {}
): Promise<ReadZipResult | null> {
  if (!path.toLowerCase().endsWith(".zip")) {
    return null;
  }

  const { isZip, size } = await peekZipContainer(path);
  if (!isZip) {
    return null;
  }

  const maxFileSize = options.maxFileSize ?? 0;
  const maxTotalSize = options.maxTotalSize ?? DEFAULT_MAX_ZIP_TOTAL_SIZE;

  // Container gate: never buffer an archive whose compressed size already
  // exceeds the total budget — its inflated contents cannot fit it anyway, and
  // reading it would risk exhausting memory. The caller then peeks the `PK`
  // header, finds no object format, and skips it without a full read.
  if (maxTotalSize > 0 && size > maxTotalSize) {
    log.warn(
      `Skipping ${path}: archive size ${size} exceeds maximum total extraction size ${maxTotalSize}`
    );
    return null;
  }

  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (err) {
    log.debug(`Skipping unreadable zip: ${path}`, err);
    return null;
  }

  let oversizedCount = 0;
  let acceptedTotal = 0;

  // The filter runs before decompression, so rejected entries are never
  // inflated into memory (the zip-bomb / memory guard).
  const filter = (file: UnzipFileInfo): boolean => {
    if (isDirectoryEntry(file.name) || file.originalSize === 0) {
      return false;
    }
    // Returning true for an entry fflate cannot inflate makes unzipSync throw,
    // which would discard the whole archive and its valid siblings. Skip it.
    if (!SUPPORTED_COMPRESSION.has(file.compression)) {
      log.debug(
        `Skipping ${path}/${file.name}: unsupported compression method ${file.compression}`
      );
      return false;
    }
    // Defense-in-depth: fflate derives originalSize from the central directory,
    // but never inflate an entry whose declared size we cannot trust.
    if (!Number.isFinite(file.originalSize)) {
      log.debug(`Skipping ${path}/${file.name}: unknown uncompressed size`);
      return false;
    }
    if (maxFileSize > 0 && file.originalSize > maxFileSize) {
      oversizedCount += 1;
      log.warn(
        `Skipping ${path}/${file.name}: uncompressed size ${file.originalSize} exceeds maximum file size ${maxFileSize}`
      );
      return false;
    }
    // Cap cumulative extraction so a flat zip-bomb of many in-range entries
    // cannot inflate unbounded (unzipSync holds all accepted entries at once).
    if (maxTotalSize > 0 && acceptedTotal + file.originalSize > maxTotalSize) {
      log.warn(
        `Skipping ${path}/${file.name}: would exceed maximum total extraction size ${maxTotalSize}`
      );
      return false;
    }
    acceptedTotal += file.originalSize;
    return true;
  };

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(new Uint8Array(data), { filter });
  } catch (err) {
    log.debug(`Skipping malformed zip: ${path}`, err);
    return null;
  }

  const entries: ZipDifEntry[] = [];
  for (const [name, bytes] of Object.entries(unzipped)) {
    entries.push({ path: `${path}/${name}`, content: Buffer.from(bytes) });
  }

  return { entries, oversizedCount };
}
