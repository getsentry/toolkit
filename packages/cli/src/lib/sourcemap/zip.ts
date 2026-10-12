/**
 * Streaming ZIP file builder.
 *
 * Writes entries to a file handle sequentially so only one file's
 * compressed data is held in memory at a time. Produces valid ZIP
 * archives that can be extracted by standard tools (unzip, 7z, etc.).
 *
 * Per-archive compression method (DEFLATE or STORED) is chosen at
 * {@link ZipWriter.create} time. STORED is preferred when the
 * caller will compress the bytes again at the wire layer (e.g.
 * chunk-upload with zstd) — see {@link ZipCompression}.
 */

import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import { deflateRaw as deflateRawCb } from "node:zlib";
import { crc32 } from "../crc32.js";

const deflateRaw = promisify(deflateRawCb);

/** Version 2.0 — minimum needed to extract DEFLATE entries. */
const ZIP_VERSION = 20;

/** Compression method: stored (no compression). */
const METHOD_STORE = 0;

/** Compression method: DEFLATE. */
const METHOD_DEFLATE = 8;

const LOCAL_FILE_HEADER_SIG = 0x04_03_4b_50;
const CENTRAL_DIR_HEADER_SIG = 0x02_01_4b_50;
const EOCD_SIG = 0x06_05_4b_50;
const ZIP64_EOCD_SIG = 0x06_06_4b_50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07_06_4b_50;

/** Version 4.5 — minimum needed to extract ZIP64 archives. */
const ZIP64_VERSION = 45;

/** Largest entry count the classic EOCD record can hold. */
const MAX_EOCD_ENTRIES = 0xff_ff;

/** Fixed portion of a local file header (before the file name). */
const LOCAL_HEADER_FIXED_SIZE = 30;

/** Fixed portion of a central directory header (before the file name). */
const CENTRAL_HEADER_FIXED_SIZE = 46;

/** End of central directory record size (no comment). */
const EOCD_SIZE = 22;

/** ZIP64 end of central directory record size (no extensible data). */
const ZIP64_EOCD_SIZE = 56;

/** ZIP64 end of central directory locator size. */
const ZIP64_EOCD_LOCATOR_SIZE = 20;

/**
 * Metadata captured per entry so the central directory can be
 * written after all entries have been streamed.
 */
type EntryRecord = {
  /** UTF-8 encoded file name. */
  name: Buffer;
  /** CRC-32 of the uncompressed data. */
  crc: number;
  /** Compression method used (0 = STORE, 8 = DEFLATE). */
  method: number;
  /** Byte length of compressed (or stored) data. */
  compressedSize: number;
  /** Byte length of the original uncompressed data. */
  uncompressedSize: number;
  /** Byte offset of this entry's local file header within the archive. */
  localHeaderOffset: number;
};

/**
 * Per-archive compression strategy. `"deflate"` mirrors the original
 * behavior; `"stored"` skips entry compression entirely and is the
 * right choice when the bytes will be re-compressed by an outer codec
 * (e.g. chunk-upload with zstd/gzip on the wire). Compressing an
 * already-compressed payload is wasted CPU and can even slightly
 * inflate the output.
 */
export type ZipCompression = "deflate" | "stored";

/**
 * Streaming ZIP archive writer.
 *
 * Entries are written to disk one at a time via {@link addEntry},
 * keeping peak memory proportional to a single entry's payload. Call
 * {@link finalize} after all entries have been added to write the
 * central directory and close the file.
 *
 * @example
 * ```ts
 * const zip = await ZipWriter.create("/tmp/bundle.zip");
 * await zip.addEntry("index.js", sourceBuffer);
 * await zip.addEntry("index.js.map", mapBuffer);
 * await zip.finalize();
 * ```
 */
export class ZipWriter {
  /** Accumulated entry metadata for the central directory. */
  private readonly entries: EntryRecord[] = [];

  /** Current write position in the output file. */
  private offset = 0;

  private readonly fh: FileHandle;

  private readonly compression: ZipCompression;

  private constructor(fh: FileHandle, compression: ZipCompression) {
    this.fh = fh;
    this.compression = compression;
  }

  /**
   * Create a new {@link ZipWriter} that writes to the given path.
   *
   * The file is created (or truncated) immediately. An 8-byte source
   * bundle header (`SYSB` magic + version 2) is written first — this
   * is required by Sentry's symbolicator which uses the `symbolic`
   * crate's `SourceBundle::test()` to identify valid bundles. Without
   * this header, the symbolicator silently skips the archive and
   * reports `js_no_source` / `missing_source`.
   *
   * The caller must eventually call {@link finalize} to produce a
   * valid archive and release the file handle.
   *
   * @param outputPath - Filesystem path for the output ZIP file.
   * @param options.compression - Per-entry compression method
   *   (`"deflate"` default; `"stored"` to skip compression — see
   *   {@link ZipCompression}).
   * @returns A ready-to-use writer instance.
   */
  static async create(
    outputPath: string,
    options: { compression?: ZipCompression } = {},
  ): Promise<ZipWriter> {
    const fh = await open(outputPath, "w");
    const writer = new ZipWriter(fh, options.compression ?? "deflate");

    // Write the SourceBundle magic header before any ZIP data.
    // Format: 4-byte magic "SYSB" + 4-byte LE version (2).
    // Sentry's symbolicator uses the `symbolic` crate to parse artifact
    // bundles. Without this header, `SourceBundle::test()` rejects the
    // archive and the symbolicator cannot extract files from it.
    const header = Buffer.alloc(8);
    header.write("SYSB", 0, 4, "ascii");
    header.writeUInt32LE(2, 4);
    await fh.write(header, 0, header.length);
    writer.offset = 8;

    return writer;
  }

  /**
   * Close the underlying file handle without finalizing the archive.
   *
   * Use for error cleanup when {@link addEntry} fails partway through.
   * The resulting file will be incomplete, but the handle won't leak.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async close(): Promise<void> {
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    await this.fh.close().catch(() => {
      // Already closed — ignore
    });
  }

  /**
   * Add a file entry to the archive.
   *
   * The data is written using the writer's configured compression
   * method (DEFLATE or STORED). Empty entries are always STORED
   * because some extractors mishandle DEFLATE of empty input.
   *
   * @param name - File path inside the archive (forward-slash separated).
   * @param data - Uncompressed file contents.
   */
  async addEntry(name: string, data: Buffer): Promise<void> {
    const nameBytes = Buffer.from(name, "utf-8");
    const checksum = crc32(data);

    const useStore = this.compression === "stored" || data.length === 0;
    const method = useStore ? METHOD_STORE : METHOD_DEFLATE;
    const payload = useStore ? data : await deflateRaw(data);

    const header = Buffer.alloc(LOCAL_HEADER_FIXED_SIZE);
    header.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    header.writeUInt16LE(ZIP_VERSION, 4);
    // General purpose bit flag — 0 (no flags)
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    // Last mod time and date — 0 (unused)
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    // oxlint-disable-next-line no-bitwise -- coerce signed CRC-32 to unsigned for writeUInt32LE
    header.writeUInt32LE(checksum >>> 0, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    // Extra field length — 0
    header.writeUInt16LE(0, 28);

    const localHeaderOffset = this.offset;

    await this.fh.write(header, 0, header.length);
    await this.fh.write(nameBytes, 0, nameBytes.length);
    if (payload.length > 0) {
      await this.fh.write(payload, 0, payload.length);
    }

    this.offset += LOCAL_HEADER_FIXED_SIZE + nameBytes.length + payload.length;

    this.entries.push({
      name: nameBytes,
      crc: checksum,
      method,
      compressedSize: payload.length,
      uncompressedSize: data.length,
      localHeaderOffset,
    });
  }

  /**
   * Finalize the archive by writing the central directory and the
   * end-of-central-directory record, then close the file handle.
   *
   * After this call the writer instance must not be reused.
   */
  async finalize(): Promise<void> {
    try {
      const centralDirOffset = this.offset;

      for (const entry of this.entries) {
        const rec = Buffer.alloc(CENTRAL_HEADER_FIXED_SIZE);
        rec.writeUInt32LE(CENTRAL_DIR_HEADER_SIG, 0);
        rec.writeUInt16LE(ZIP_VERSION, 4);
        rec.writeUInt16LE(ZIP_VERSION, 6);
        // General purpose bit flag — 0
        rec.writeUInt16LE(0, 8);
        rec.writeUInt16LE(entry.method, 10);
        // Last mod time and date — 0
        rec.writeUInt16LE(0, 12);
        rec.writeUInt16LE(0, 14);
        // oxlint-disable-next-line no-bitwise -- coerce signed CRC-32 to unsigned for writeUInt32LE
        rec.writeUInt32LE(entry.crc >>> 0, 16);
        rec.writeUInt32LE(entry.compressedSize, 20);
        rec.writeUInt32LE(entry.uncompressedSize, 24);
        rec.writeUInt16LE(entry.name.length, 28);
        // Extra field length — 0
        rec.writeUInt16LE(0, 30);
        // File comment length — 0
        rec.writeUInt16LE(0, 32);
        // Disk number start — 0
        rec.writeUInt16LE(0, 34);
        // Internal file attributes — 0
        rec.writeUInt16LE(0, 36);
        // External file attributes — 0
        rec.writeUInt32LE(0, 38);
        rec.writeUInt32LE(entry.localHeaderOffset, 42);

        await this.fh.write(rec, 0, rec.length);
        await this.fh.write(entry.name, 0, entry.name.length);

        this.offset += CENTRAL_HEADER_FIXED_SIZE + entry.name.length;
      }

      const centralDirSize = this.offset - centralDirOffset;

      // The classic EOCD stores the entry count in 16 bits. Larger bundles
      // need a ZIP64 EOCD record + locator, with 0xFFFF as the sentinel.
      const needsZip64 = this.entries.length > MAX_EOCD_ENTRIES;
      if (needsZip64) {
        await this.writeZip64EndRecords(centralDirOffset, centralDirSize);
      }
      const eocdEntries = needsZip64 ? MAX_EOCD_ENTRIES : this.entries.length;

      const eocd = Buffer.alloc(EOCD_SIZE);
      eocd.writeUInt32LE(EOCD_SIG, 0);
      // Disk number — 0
      eocd.writeUInt16LE(0, 4);
      // Disk number with central directory — 0
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(eocdEntries, 8);
      eocd.writeUInt16LE(eocdEntries, 10);
      eocd.writeUInt32LE(centralDirSize, 12);
      eocd.writeUInt32LE(centralDirOffset, 16);
      // ZIP file comment length — 0
      eocd.writeUInt16LE(0, 20);

      await this.fh.write(eocd, 0, eocd.length);
    } finally {
      await this.fh.close();
    }
  }

  /**
   * Write the ZIP64 end of central directory record and its locator.
   * Must be called right after the central directory, before the EOCD.
   */
  private async writeZip64EndRecords(
    centralDirOffset: number,
    centralDirSize: number,
  ): Promise<void> {
    const zip64EocdOffset = this.offset;
    const entryCount = BigInt(this.entries.length);

    const record = Buffer.alloc(ZIP64_EOCD_SIZE);
    record.writeUInt32LE(ZIP64_EOCD_SIG, 0);
    // Size of the remaining record (excludes signature and this field)
    record.writeBigUInt64LE(BigInt(ZIP64_EOCD_SIZE - 12), 4);
    record.writeUInt16LE(ZIP64_VERSION, 12);
    record.writeUInt16LE(ZIP64_VERSION, 14);
    // Disk number and disk with central directory — 0
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(0, 20);
    record.writeBigUInt64LE(entryCount, 24);
    record.writeBigUInt64LE(entryCount, 32);
    record.writeBigUInt64LE(BigInt(centralDirSize), 40);
    record.writeBigUInt64LE(BigInt(centralDirOffset), 48);

    const locator = Buffer.alloc(ZIP64_EOCD_LOCATOR_SIZE);
    locator.writeUInt32LE(ZIP64_EOCD_LOCATOR_SIG, 0);
    // Disk with the ZIP64 EOCD record — 0
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
    // Total number of disks — 1
    locator.writeUInt32LE(1, 16);

    await this.fh.write(record, 0, record.length);
    await this.fh.write(locator, 0, locator.length);
    this.offset += ZIP64_EOCD_SIZE + ZIP64_EOCD_LOCATOR_SIZE;
  }
}
