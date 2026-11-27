/**
 * Streaming ZIP file builder.
 *
 * Writes entries to a file handle in order, holding only the entries
 * being compressed in memory. Produces valid ZIP archives that can be
 * extracted by standard tools (unzip, 7z, etc.).
 *
 * Per-archive compression method (DEFLATE or STORED) is chosen at
 * {@link ZipWriter.create} time — see {@link ZipCompression}.
 */

import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { promisify } from "node:util";
import { deflateRaw as deflateRawCb } from "node:zlib";
import { crc32 } from "../crc32.js";

const deflateRaw = promisify(deflateRawCb);

/**
 * zlib level for DEFLATE entries. Level 4 is zlib's first lazy-matching
 * level: on minified JavaScript and sourcemaps it is ~40% faster than the
 * default 6 for ~4% larger output, which keeps large uploads fast on
 * 2-vCPU CI runners.
 */
const DEFLATE_LEVEL = 4;

/** Default read-ahead of {@link ZipWriter.addEntries}, per available CPU. */
const READ_AHEAD_PER_CPU = 16;

/** Cap on uncompressed bytes read ahead by {@link ZipWriter.addEntries}. */
const READ_AHEAD_MAX_BYTES = 256 * 1024 * 1024;

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
  /**
   * File name. Kept as a string, not a Buffer: a small Buffer is a slice
   * of Node's shared allocation pool, which zlib also fills with output
   * chunks, so holding one name per entry until {@link ZipWriter.finalize}
   * pins a whole pool slab per entry (gigabytes for large bundles).
   */
  name: string;
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
 * Per-archive compression strategy. `"deflate"` compresses each entry;
 * `"stored"` skips entry compression entirely. Pick `"stored"` only when
 * the archive itself is never kept: a wire codec (chunk-upload zstd or
 * gzip) is decoded by the server, so an archive stored this way is kept
 * uncompressed.
 */
export type ZipCompression = "deflate" | "stored";

/** An entry for {@link ZipWriter.addEntries}, read only when needed. */
type ZipEntrySource = {
  /** File path inside the archive (forward-slash separated). */
  name: string;
  /** Load the uncompressed contents. */
  read: () => Promise<Buffer>;
};

/** An entry that is checksummed and compressed but not yet written. */
type EncodedEntry = {
  name: string;
  crc: number;
  method: number;
  payload: Buffer;
  uncompressedSize: number;
};

type EncodedResult =
  | { ok: true; entry: EncodedEntry }
  | { ok: false; error: unknown };

/**
 * Streaming ZIP archive writer.
 *
 * Entries are written to disk in order via {@link addEntry} or
 * {@link addEntries}, keeping peak memory proportional to the entries
 * being compressed. Call {@link finalize} after all entries have been
 * added to write the central directory and close the file.
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
    options: { compression?: ZipCompression | undefined } = {},
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
    await this.writeEntry(await this.encodeEntry(name, data));
  }

  /**
   * Add many entries, compressing several at once.
   *
   * Entries are read and compressed ahead of the one being written.
   * zlib runs on the libuv threadpool, so this spreads DEFLATE across
   * cores instead of compressing one file at a time. Entries are
   * written in input order, so the archive is byte-identical to calling
   * {@link addEntry} for each one.
   *
   * The read-ahead window is deep (16 entries per CPU by default) because
   * the writer is strictly in order: one large sourcemap at the head
   * would otherwise idle the other threads. Entries already read but not
   * yet written are capped at {@link READ_AHEAD_MAX_BYTES} so a run of
   * huge files cannot exhaust memory on small CI runners.
   *
   * @param sources - Entries in archive order.
   * @param options.concurrency - Entries in flight. Defaults to 16 per
   *   CPU available to the process.
   */
  async addEntries(
    sources: readonly ZipEntrySource[],
    options: { concurrency?: number | undefined } = {},
  ): Promise<void> {
    const maxEntries = Math.max(
      1,
      options.concurrency ?? READ_AHEAD_PER_CPU * availableParallelism(),
    );
    const inFlight: Promise<EncodedResult>[] = [];
    let bytesInFlight = 0;
    let next = 0;
    const startNext = (): void => {
      const source = sources[next] as ZipEntrySource;
      next += 1;
      // Settle into a result object so entries still in flight when an
      // earlier one fails never become unhandled rejections.
      inFlight.push(
        source.read().then(
          async (data): Promise<EncodedResult> => {
            bytesInFlight += data.length;
            return {
              ok: true,
              entry: await this.encodeEntry(source.name, data),
            };
          },
          (error: unknown): EncodedResult => ({ ok: false, error }),
        ),
      );
    };
    const fill = (): void => {
      while (
        next < sources.length &&
        (inFlight.length === 0 ||
          (inFlight.length < maxEntries &&
            bytesInFlight < READ_AHEAD_MAX_BYTES))
      ) {
        startNext();
      }
    };

    fill();
    for (let result = inFlight.shift(); result; result = inFlight.shift()) {
      const settled = await result;
      if (!settled.ok) {
        throw settled.error;
      }
      await this.writeEntry(settled.entry);
      bytesInFlight -= settled.entry.uncompressedSize;
      fill();
    }
  }

  /** Checksum and compress one entry. Does not touch the file. */
  private async encodeEntry(name: string, data: Buffer): Promise<EncodedEntry> {
    const useStore = this.compression === "stored" || data.length === 0;
    return {
      name,
      crc: crc32(data),
      method: useStore ? METHOD_STORE : METHOD_DEFLATE,
      payload: useStore
        ? data
        : await deflateRaw(data, { level: DEFLATE_LEVEL }),
      uncompressedSize: data.length,
    };
  }

  /** Append an encoded entry's local header and payload to the file. */
  private async writeEntry(entry: EncodedEntry): Promise<void> {
    const { crc: checksum, method, payload } = entry;
    const nameBytes = Buffer.from(entry.name, "utf-8");

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
    header.writeUInt32LE(entry.uncompressedSize, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    // Extra field length — 0
    header.writeUInt16LE(0, 28);

    const localHeaderOffset = this.offset;

    // One write per entry: every write is a threadpool round-trip that
    // queues behind in-flight DEFLATE jobs.
    await this.fh.writev(
      payload.length > 0 ? [header, nameBytes, payload] : [header, nameBytes],
    );

    this.offset += LOCAL_HEADER_FIXED_SIZE + nameBytes.length + payload.length;

    this.entries.push({
      name: entry.name,
      crc: checksum,
      method,
      compressedSize: payload.length,
      uncompressedSize: entry.uncompressedSize,
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

      // Build the central directory in memory (~90 bytes per entry) and
      // write it at once instead of two writes per entry.
      const centralDir: Buffer[] = [];
      for (const entry of this.entries) {
        const nameBytes = Buffer.from(entry.name, "utf-8");
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
        rec.writeUInt16LE(nameBytes.length, 28);
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

        centralDir.push(rec, nameBytes);
        this.offset += CENTRAL_HEADER_FIXED_SIZE + nameBytes.length;
      }
      const centralDirBytes = Buffer.concat(centralDir);
      await this.fh.write(centralDirBytes, 0, centralDirBytes.length);

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
