/**
 * Deterministic streaming ZIP writer for normalized build wrappers.
 *
 * Writes STORE-only (uncompressed) ZIP entries to a file handle one at a time,
 * so peak memory is bounded by a single chunk rather than the whole archive.
 * This replaces the previous in-memory `zipSync` assembly, which held the build
 * plus the wrapper in memory at once (bounded only by Node's ~2 GiB Buffer cap).
 *
 * Byte-for-byte determinism matters: an identical build must produce an
 * identical wrapper so the server can dedup already-uploaded chunks across
 * re-uploads. The output here is byte-identical to the previous
 * `fflate.zipSync(..., { level: 0, mtime, os, attrs })` encoding — same local
 * headers, central directory, and end-of-central-directory record — so wrapper
 * bytes are unchanged for existing builds. STORE is used because APK/AAB/IPA are
 * themselves already-compressed ZIPs (re-compressing wins ~nothing), and a fixed
 * modification time keeps the bytes stable run to run.
 */

import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { crc32 } from "../crc32.js";

/** Local-file-header signature (`PK\x03\x04`). */
const LOCAL_FILE_HEADER_SIG = 0x0403_4b50;
/** Central-directory-header signature (`PK\x01\x02`). */
const CENTRAL_DIR_HEADER_SIG = 0x0201_4b50;
/** End-of-central-directory signature (`PK\x05\x06`). */
const EOCD_SIG = 0x0605_4b50;

/** Fixed portion of a local file header (before the file name). */
const LOCAL_HEADER_FIXED_SIZE = 30;
/** Fixed portion of a central directory header (before the file name). */
const CENTRAL_HEADER_FIXED_SIZE = 46;
/** End-of-central-directory record size (no archive comment). */
const EOCD_SIZE = 22;

/** ZIP version needed to extract (2.0). Matches fflate's fixed value. */
const ZIP_VERSION = 20;
/** Compression method: STORE (no compression). */
const METHOD_STORE = 0;

/**
 * Fixed modification time for every entry (the ZIP epoch, 1980-01-01). A
 * constant timestamp keeps the wrapper byte-deterministic across runs.
 */
export const FIXED_MTIME = new Date("1980-01-01T00:00:00Z");

/** Size of the buffer used to stream file entries chunk by chunk. */
const STREAM_CHUNK_SIZE = 1 << 20; // 1 MiB

/** Metadata retained per entry so the central directory can be written last. */
type CentralRecord = {
  /** UTF-8 encoded entry name. */
  nameBytes: Buffer;
  /** General-purpose bit flag (only the UTF-8 name bit is ever set). */
  flag: number;
  /** CRC-32 of the (uncompressed) data. */
  crc: number;
  /** Stored byte length (STORE ⇒ compressed size === uncompressed size). */
  size: number;
  /** DOS-format modification date+time. */
  dosTime: number;
  /** ZIP host OS byte (0 = MS-DOS, 3 = Unix for symlinks/permission bits). */
  os: number;
  /** External file attributes (Unix mode in the upper 16 bits). */
  attrs: number;
  /** Byte offset of this entry's local file header within the archive. */
  localHeaderOffset: number;
};

/** Options controlling an entry's ZIP host OS and external attributes. */
export type ZipEntryOptions = {
  /** ZIP host OS byte (3 = Unix). Defaults to 0 (MS-DOS). */
  os?: number;
  /** External file attributes (Unix mode in the upper 16 bits). Defaults to 0. */
  attrs?: number;
};

/** Convert a `Date` to a packed DOS date+time value. */
function toDosTime(mtime: Date): number {
  const year = mtime.getFullYear() - 1980;
  return (
    ((year << 25) |
      ((mtime.getMonth() + 1) << 21) |
      (mtime.getDate() << 16) |
      (mtime.getHours() << 11) |
      (mtime.getMinutes() << 5) |
      (mtime.getSeconds() >> 1)) >>>
    0
  );
}

/** Packed DOS modification time for {@link FIXED_MTIME}, computed once. */
const FIXED_DOS_TIME = toDosTime(FIXED_MTIME);

/**
 * Deterministic streaming ZIP archive writer (STORE only).
 *
 * Add entries with {@link addData} (in-memory bytes) or {@link addFile}
 * (streamed from a source file), then call {@link finalize} to write the
 * central directory and close the handle. Entries are emitted in the order they
 * are added, so the caller sorts entry names up-front to keep the output stable.
 */
export class DeterministicZipWriter {
  private readonly entries: CentralRecord[] = [];
  private offset = 0;
  private readonly fh: FileHandle;

  private constructor(fh: FileHandle) {
    this.fh = fh;
  }

  /**
   * Create a writer for `outputPath`, truncating any existing file.
   *
   * The caller must eventually call {@link finalize} (or {@link close} on the
   * error path) to release the handle.
   */
  static async create(outputPath: string): Promise<DeterministicZipWriter> {
    const fh = await open(outputPath, "w");
    return new DeterministicZipWriter(fh);
  }

  /** Write a local file header and return the entry's central-dir metadata. */
  private async writeLocalHeader(
    name: string,
    crc: number,
    size: number,
    options: ZipEntryOptions,
  ): Promise<CentralRecord> {
    const nameBytes = Buffer.from(name, "utf-8");
    // fflate sets the UTF-8 name flag (bit 11) when the encoded name is longer
    // than its UTF-16 length (i.e. it contains multi-byte characters).
    const flag = nameBytes.length !== name.length ? 0x0800 : 0;

    const header = Buffer.alloc(LOCAL_HEADER_FIXED_SIZE);
    header.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    header.writeUInt16LE(ZIP_VERSION, 4);
    header.writeUInt16LE(flag, 6);
    header.writeUInt16LE(METHOD_STORE, 8);
    header.writeUInt32LE(FIXED_DOS_TIME, 10);
    header.writeUInt32LE(crc >>> 0, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28); // extra field length

    const localHeaderOffset = this.offset;
    await this.fh.write(header, 0, header.length);
    await this.fh.write(nameBytes, 0, nameBytes.length);
    this.offset += LOCAL_HEADER_FIXED_SIZE + nameBytes.length;

    return {
      nameBytes,
      flag,
      crc: crc >>> 0,
      size,
      dosTime: FIXED_DOS_TIME,
      os: options.os ?? 0,
      attrs: (options.attrs ?? 0) >>> 0,
      localHeaderOffset,
    };
  }

  /**
   * Add an entry whose full contents are already in memory.
   *
   * Suitable for small payloads (metadata files, generated plists, symlink
   * targets). Large payloads should use {@link addFile} to stay bounded.
   */
  async addData(
    name: string,
    data: Uint8Array,
    options: ZipEntryOptions = {},
  ): Promise<void> {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const crc = crc32(buf) >>> 0;
    const record = await this.writeLocalHeader(name, crc, buf.length, options);
    if (buf.length > 0) {
      await this.fh.write(buf, 0, buf.length);
      this.offset += buf.length;
    }
    this.entries.push(record);
  }

  /**
   * Add an entry streamed from a source file on disk.
   *
   * The source is read in two passes: first to compute the CRC-32 and size
   * (needed in the STORE local header, which carries no data descriptor), then
   * to copy the bytes into the archive. Only one {@link STREAM_CHUNK_SIZE}
   * buffer is live at a time, so peak memory does not scale with file size.
   */
  async addFile(
    name: string,
    sourcePath: string,
    options: ZipEntryOptions = {},
  ): Promise<void> {
    const src = await open(sourcePath, "r");
    try {
      // Pass 1: CRC-32 + size.
      let crc = 0;
      let size = 0;
      const buf = Buffer.allocUnsafe(STREAM_CHUNK_SIZE);
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, null);
        if (bytesRead === 0) {
          break;
        }
        crc = crc32(buf.subarray(0, bytesRead), crc);
        size += bytesRead;
      }
      crc >>>= 0;

      const record = await this.writeLocalHeader(name, crc, size, options);

      // Pass 2: copy the stored bytes.
      let position = 0;
      while (position < size) {
        const { bytesRead } = await src.read(buf, 0, buf.length, position);
        if (bytesRead === 0) {
          break;
        }
        await this.fh.write(buf, 0, bytesRead);
        position += bytesRead;
      }
      this.offset += size;
      this.entries.push(record);
    } finally {
      await src.close();
    }
  }

  /**
   * Write the central directory + end-of-central-directory record, then close
   * the handle. The writer must not be reused afterward.
   */
  async finalize(): Promise<void> {
    try {
      const centralDirOffset = this.offset;
      for (const entry of this.entries) {
        const rec = Buffer.alloc(CENTRAL_HEADER_FIXED_SIZE);
        rec.writeUInt32LE(CENTRAL_DIR_HEADER_SIG, 0);
        rec.writeUInt8(ZIP_VERSION, 4); // version made by (low byte)
        rec.writeUInt8(entry.os, 5); // version made by (host OS)
        rec.writeUInt16LE(ZIP_VERSION, 6); // version needed
        rec.writeUInt16LE(entry.flag, 8);
        rec.writeUInt16LE(METHOD_STORE, 10);
        rec.writeUInt32LE(entry.dosTime, 12);
        rec.writeUInt32LE(entry.crc, 16);
        rec.writeUInt32LE(entry.size, 20);
        rec.writeUInt32LE(entry.size, 24);
        rec.writeUInt16LE(entry.nameBytes.length, 28);
        rec.writeUInt16LE(0, 30); // extra field length
        rec.writeUInt16LE(0, 32); // comment length
        rec.writeUInt16LE(0, 34); // disk number start
        rec.writeUInt16LE(0, 36); // internal attributes
        rec.writeUInt32LE(entry.attrs, 38); // external attributes
        rec.writeUInt32LE(entry.localHeaderOffset, 42);

        await this.fh.write(rec, 0, rec.length);
        await this.fh.write(entry.nameBytes, 0, entry.nameBytes.length);
        this.offset += CENTRAL_HEADER_FIXED_SIZE + entry.nameBytes.length;
      }

      const centralDirSize = this.offset - centralDirOffset;
      const eocd = Buffer.alloc(EOCD_SIZE);
      eocd.writeUInt32LE(EOCD_SIG, 0);
      eocd.writeUInt16LE(0, 4); // disk number
      eocd.writeUInt16LE(0, 6); // disk with central directory
      eocd.writeUInt16LE(this.entries.length, 8);
      eocd.writeUInt16LE(this.entries.length, 10);
      eocd.writeUInt32LE(centralDirSize, 12);
      eocd.writeUInt32LE(centralDirOffset, 16);
      eocd.writeUInt16LE(0, 20); // archive comment length

      await this.fh.write(eocd, 0, eocd.length);
    } finally {
      await this.fh.close();
    }
  }

  /**
   * Close the handle without finalizing (error cleanup). Safe to call more than
   * once; the resulting file is incomplete but the handle won't leak.
   */
  async close(): Promise<void> {
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- Closing an already closed handle is harmless during error cleanup.
    await this.fh.close().catch(() => {
      // Already closed — ignore.
    });
  }
}
