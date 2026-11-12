/**
 * Builders for minimal Mach-O test fixtures.
 *
 * Each thin object carries a Mach-O header, an `LC_UUID` (its debug id), and
 * an `LC_SYMTAB` with one symbol, which is enough for symbolic to report a
 * debug id, an architecture, and a symbol table. The fat builder wraps thin
 * objects behind a 32-bit `fat_header`, laid out the way `lipo` does it:
 * each slice starts on a page boundary.
 */

const MH_MAGIC = 0xfe_ed_fa_ce;
const MH_MAGIC_64 = 0xfe_ed_fa_cf;
const FAT_MAGIC = 0xca_fe_ba_be;
const MH_EXECUTE = 2;
const LC_SYMTAB = 0x2;
const LC_UUID = 0x1b;
/** `N_SECT | N_EXT`: an external symbol defined in a section. */
const N_SECT_EXT = 0x0f;
/** Slice alignment (16 KiB pages, as `lipo` lays out arm64 slices). */
const PAGE_ALIGN_LOG2 = 14;
const PAGE_ALIGN = 2 ** PAGE_ALIGN_LOG2;

/** A thin Mach-O architecture. */
export type MachOArch = {
  cputype: number;
  cpusubtype: number;
  is64: boolean;
};

/** `arm64` (64-bit header). */
export const ARM64: MachOArch = {
  cputype: 0x01_00_00_0c,
  cpusubtype: 0,
  is64: true,
};

/** `arm64_32` (watchOS; 32-bit header, `CPU_ARCH_ABI64_32`). */
const ARM64_32: MachOArch = {
  cputype: 0x02_00_00_0c,
  cpusubtype: 1,
  is64: false,
};

/**
 * Build a thin Mach-O object for `arch` whose debug id is `debugId`.
 *
 * @param arch - The slice architecture.
 * @param debugId - Hyphenated UUID stored in `LC_UUID`.
 */
export function thinMachO(arch: MachOArch, debugId: string): Buffer {
  const headerSize = arch.is64 ? 32 : 28;
  const nlistSize = arch.is64 ? 16 : 12;
  const uuidCmdSize = 24;
  const symtabCmdSize = 24;
  const symoff = headerSize + uuidCmdSize + symtabCmdSize;
  const stroff = symoff + nlistSize;
  const strtab = Buffer.from("\0_main\0", "latin1");
  const buf = Buffer.alloc(stroff + strtab.length);

  buf.writeUInt32LE(arch.is64 ? MH_MAGIC_64 : MH_MAGIC, 0);
  buf.writeUInt32LE(arch.cputype, 4);
  buf.writeUInt32LE(arch.cpusubtype, 8);
  buf.writeUInt32LE(MH_EXECUTE, 12);
  buf.writeUInt32LE(2, 16); // ncmds
  buf.writeUInt32LE(uuidCmdSize + symtabCmdSize, 20); // sizeofcmds

  let offset = headerSize;
  buf.writeUInt32LE(LC_UUID, offset);
  buf.writeUInt32LE(uuidCmdSize, offset + 4);
  Buffer.from(debugId.replaceAll("-", ""), "hex").copy(buf, offset + 8);
  offset += uuidCmdSize;

  buf.writeUInt32LE(LC_SYMTAB, offset);
  buf.writeUInt32LE(symtabCmdSize, offset + 4);
  buf.writeUInt32LE(symoff, offset + 8);
  buf.writeUInt32LE(1, offset + 12); // nsyms
  buf.writeUInt32LE(stroff, offset + 16);
  buf.writeUInt32LE(strtab.length, offset + 20);

  buf.writeUInt32LE(1, symoff); // n_strx -> "_main"
  buf.writeUInt8(N_SECT_EXT, symoff + 4);
  buf.writeUInt8(1, symoff + 5); // n_sect
  if (arch.is64) {
    buf.writeBigUInt64LE(0x1000n, symoff + 8);
  } else {
    buf.writeUInt32LE(0x1000, symoff + 8);
  }
  strtab.copy(buf, stroff);
  return buf;
}

/**
 * Wrap thin Mach-O objects in a fat (universal) container.
 *
 * @param slices - Each slice's architecture and thin object bytes.
 */
function fatMachO(slices: { arch: MachOArch; object: Buffer }[]): Buffer {
  const header = Buffer.alloc(8 + slices.length * 20);
  header.writeUInt32BE(FAT_MAGIC, 0);
  header.writeUInt32BE(slices.length, 4);
  const parts: Buffer[] = [header];
  let cursor = header.length;
  for (const [i, { arch, object }] of slices.entries()) {
    const start = Math.ceil(cursor / PAGE_ALIGN) * PAGE_ALIGN;
    parts.push(Buffer.alloc(start - cursor), object);
    const entry = 8 + i * 20;
    header.writeUInt32BE(arch.cputype, entry);
    header.writeUInt32BE(arch.cpusubtype, entry + 4);
    header.writeUInt32BE(start, entry + 8);
    header.writeUInt32BE(object.length, entry + 12);
    header.writeUInt32BE(PAGE_ALIGN_LOG2, entry + 16);
    cursor = start + object.length;
  }
  return Buffer.concat(parts);
}

/** Debug id of the `arm64` slice in {@link watchFatMachO}. */
export const WATCH_ARM64_DEBUG_ID = "8c4cd4e7-db7c-3ac8-bc5b-605af57bd7e2";
/** Debug id of the `arm64_32` slice in {@link watchFatMachO}. */
export const WATCH_ARM64_32_DEBUG_ID = "46fc586d-b173-37c8-b1cd-34d3cbeff085";

/**
 * A fat Mach-O shaped like an Xcode watchOS build: an `arm64` and an
 * `arm64_32` slice, each with its own debug id.
 */
export function watchFatMachO(): Buffer {
  return fatMachO([
    { arch: ARM64, object: thinMachO(ARM64, WATCH_ARM64_DEBUG_ID) },
    { arch: ARM64_32, object: thinMachO(ARM64_32, WATCH_ARM64_32_DEBUG_ID) },
  ]);
}
