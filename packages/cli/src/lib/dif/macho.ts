/**
 * Fat (universal) Mach-O splitting.
 *
 * A fat Mach-O holds one thin Mach-O per architecture behind a big-endian
 * header (`<mach-o/fat.h>`). Sentry's assemble step accepts exactly one object
 * per uploaded file, so a fat dSYM must be uploaded as one file per slice, the
 * way the legacy `sentry-cli` uploads each object of a fat archive. The
 * `@sentry/symbolic` WASM API reports the objects but not their byte ranges,
 * so this module reads the ranges from the fat header itself.
 */

/** `FAT_MAGIC`: fat header with 32-bit `fat_arch` entries. */
const FAT_MAGIC = 0xca_fe_ba_be;
/** `FAT_MAGIC_64`: fat header with 64-bit `fat_arch_64` entries. */
const FAT_MAGIC_64 = 0xca_fe_ba_bf;

/** Size of `fat_header` (magic + nfat_arch). */
const FAT_HEADER_SIZE = 8;
/** Size of `fat_arch` (cputype, cpusubtype, offset, size, align). */
const FAT_ARCH_SIZE = 20;
/** Size of `fat_arch_64` (cputype, cpusubtype, offset, size, align, reserved). */
const FAT_ARCH_64_SIZE = 32;

/**
 * Split a fat Mach-O into its per-architecture slices.
 *
 * Returns `null` when `data` has no fat header, or when the header is
 * malformed (no entries, an entry table past the end of the buffer, or a
 * slice range outside the buffer). The magic `0xcafebabe` is shared with Java
 * class files, so call this only on data that symbolic already parsed as a
 * Mach-O.
 *
 * @param data - The full contents of the candidate file.
 * @returns One view per slice, in header order, sharing `data`'s memory.
 */
export function splitFatMachO(data: Buffer): Buffer[] | null {
  if (data.length < FAT_HEADER_SIZE) {
    return null;
  }
  const magic = data.readUInt32BE(0);
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) {
    return null;
  }
  const is64 = magic === FAT_MAGIC_64;
  const entrySize = is64 ? FAT_ARCH_64_SIZE : FAT_ARCH_SIZE;
  const count = data.readUInt32BE(4);
  if (count === 0 || FAT_HEADER_SIZE + count * entrySize > data.length) {
    return null;
  }

  const slices: Buffer[] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = FAT_HEADER_SIZE + i * entrySize;
    // cputype (4) and cpusubtype (4) precede the offset in both layouts.
    const offset = is64
      ? Number(data.readBigUInt64BE(entry + 8))
      : data.readUInt32BE(entry + 8);
    const size = is64
      ? Number(data.readBigUInt64BE(entry + 16))
      : data.readUInt32BE(entry + 12);
    if (size === 0 || offset + size > data.length) {
      return null;
    }
    slices.push(data.subarray(offset, offset + size));
  }
  return slices;
}
