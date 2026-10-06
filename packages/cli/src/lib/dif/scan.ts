/**
 * Debug information file scanning and filtering.
 *
 * Walks files and directories for debug information files, parses each via the
 * bundled `symbolic` WASM module, and applies the `debug-files upload` filter
 * rules (`--type`, `--id`, `--no-debug`/`--no-unwind`/`--no-sources`). The pure
 * filter predicates ({@link objectPassesFilters}, {@link normalizeDebugId}) are
 * separated from the I/O ({@link scanPaths}, {@link prepareDifs}) so the matching
 * logic can be property-tested without touching the filesystem.
 *
 * `.zip` archives encountered during a scan are expanded in memory (see
 * {@link ./zip.js}) and their entries run through the same filter pipeline,
 * unless ZIP scanning is disabled via {@link PrepareDifsOptions.scanZips}.
 *
 * Type matching maps the user-facing `--type` value to the canonical object
 * file format reported by the parser (e.g. `dsym`/`macho` → `macho`,
 * `jvm` → `sourcebundle`). This is format-level matching: `--type dsym` and
 * `--type macho` are equivalent here, and the feature filters narrow further.
 */

import { open, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { ValidationError } from "../errors.js";
import { logger } from "../logger.js";
import { type WalkEntry, walkFiles } from "../scan/index.js";
import {
  type DifArchiveInfo,
  type DifObjectInfo,
  extractEmbeddedPpdb,
  parseDebugFile,
  peekFormat,
  selectBundledObject,
} from "./index.js";
import { DEFAULT_MAX_ZIP_TOTAL_SIZE, readZipDifEntries } from "./zip.js";

const log = logger.withTag("dif.scan");

/**
 * Nil debug id (hyphenated UUID form). An object whose debug id starts with
 * this carries no real identifier and cannot be symbolicated, so it is never
 * uploadable. PE/PDB ids may append an `-<age>` suffix, hence prefix matching.
 */
const NIL_DEBUG_ID_PREFIX = "00000000-0000-0000-0000-000000000000";

/**
 * Map of accepted `--type` values to the canonical object file format the
 * parser reports. Multiple type aliases can map to the same format.
 */
const TYPE_TO_FORMAT: Readonly<Record<string, string>> = {
  dsym: "macho",
  macho: "macho",
  elf: "elf",
  pe: "pe",
  pdb: "pdb",
  portablepdb: "portablepdb",
  wasm: "wasm",
  breakpad: "breakpad",
  sourcebundle: "sourcebundle",
  jvm: "sourcebundle",
};

/** Accepted `--type` filter values. */
export const VALID_DIF_TYPES: readonly string[] = Object.keys(TYPE_TO_FORMAT);

/** Resolved filter set applied to each parsed object. */
export type DifFilters = {
  /** Accepted file formats (canonical names), or `undefined` for any. */
  formats?: Set<string>;
  /** Accepted debug ids (normalized), or `undefined` for any. */
  ids?: Set<string>;
  /** Whether a symbol table satisfies the feature requirement. */
  symtab: boolean;
  /** Whether debug info satisfies the feature requirement. */
  debug: boolean;
  /** Whether unwind info satisfies the feature requirement. */
  unwind: boolean;
  /** Whether embedded/referenced sources satisfy the feature requirement. */
  sources: boolean;
};

/** Flag inputs used to build a {@link DifFilters}. */
export type DifFilterOptions = {
  /** Repeatable `--type` values (e.g. `dsym`, `elf`). */
  types?: string[];
  /** Repeatable `--id` values (debug ids). */
  ids?: string[];
  /** `--no-debug`: drop both debug and symbol-table features. */
  noDebug?: boolean;
  /** `--no-unwind`: drop unwind features. */
  noUnwind?: boolean;
  /** `--no-sources`: drop source features. */
  noSources?: boolean;
};

/** A debug information file that passed filtering, ready to upload. */
export type PreparedDif = {
  /** Filesystem path the file was read from. */
  path: string;
  /** Raw file content. */
  content: Buffer;
  /**
   * Advisory debug id of the primary (first debug-info) object among the
   * filter-matched set. This is the same id used as the source bundle's
   * debug id under `--include-sources`, so the bundle's slice matches the
   * slice whose metadata the main DIF advertises.
   */
  debugId?: string;
  /** The objects within the file that passed the filters (for reporting). */
  objects: DifObjectInfo[];
};

/**
 * Normalize a debug id for comparison: trim, lowercase, and strip braces.
 *
 * @param id - A debug id, possibly brace-wrapped or mixed-case.
 * @returns The normalized form.
 */
export function normalizeDebugId(id: string): string {
  return id.trim().toLowerCase().replace(/[{}]/g, "");
}

/**
 * Reduce a normalized debug id to its base UUID, dropping any age/appendix
 * suffix. A standard UUID has 5 hyphen-separated groups; PE/PDB ids append a
 * 6th group (`-<age>`).
 */
function baseDebugId(normalized: string): string {
  const parts = normalized.split("-");
  return parts.length > 5 ? parts.slice(0, 5).join("-") : normalized;
}

/** Whether an object carries a real (non-nil) debug id. */
function hasValidDebugId(obj: DifObjectInfo): boolean {
  const id = normalizeDebugId(obj.debugId);
  return id.length > 0 && !id.startsWith(NIL_DEBUG_ID_PREFIX);
}

/** Whether the object's format is one of the requested types (or no filter). */
function formatMatches(
  objFormat: string,
  formats: Set<string> | undefined
): boolean {
  return !formats || formats.size === 0 || formats.has(objFormat);
}

/**
 * Whether two debug ids refer to the same object, ignoring case, braces, and
 * any PE/PDB age suffix (so a base UUID matches its aged form and vice versa).
 *
 * @param a - First debug id (any casing/form).
 * @param b - Second debug id (any casing/form).
 */
export function debugIdMatches(a: string, b: string): boolean {
  const normA = normalizeDebugId(a);
  const normB = normalizeDebugId(b);
  return normA === normB || baseDebugId(normA) === baseDebugId(normB);
}

/** Whether the object's debug id matches a requested id (or no filter). */
function idMatches(objDebugId: string, ids: Set<string> | undefined): boolean {
  if (!ids || ids.size === 0) {
    return true;
  }
  for (const wanted of ids) {
    if (debugIdMatches(objDebugId, wanted)) {
      return true;
    }
  }
  return false;
}

/** Whether the object carries at least one of the wanted features. */
function featureMatches(obj: DifObjectInfo, filters: DifFilters): boolean {
  return (
    (filters.debug && obj.hasDebugInfo) ||
    (filters.symtab && obj.hasSymbols) ||
    (filters.unwind && obj.hasUnwindInfo) ||
    (filters.sources && obj.hasSources)
  );
}

/**
 * Build a {@link DifFilters} from command flags.
 *
 * `--no-debug` drops both the debug and symbol-table features (matching the
 * legacy `sentry-cli` semantics). At least one feature always remains wanted
 * unless every `--no-*` flag is set, in which case nothing would match.
 *
 * @param options - Raw flag inputs.
 * @returns The resolved filter set.
 * @throws {ValidationError} If a `--type` value is not recognized.
 */
export function buildDifFilters(options: DifFilterOptions): DifFilters {
  let formats: Set<string> | undefined;
  if (options.types && options.types.length > 0) {
    formats = new Set<string>();
    for (const raw of options.types) {
      const type = raw.trim().toLowerCase();
      const format = TYPE_TO_FORMAT[type];
      if (!format) {
        throw new ValidationError(
          `Unknown debug file type '${raw}'. Valid types: ${VALID_DIF_TYPES.join(", ")}`,
          "type"
        );
      }
      formats.add(format);
    }
  }

  let ids: Set<string> | undefined;
  if (options.ids && options.ids.length > 0) {
    ids = new Set(options.ids.map((id) => normalizeDebugId(id)));
  }

  return {
    formats,
    ids,
    symtab: !options.noDebug,
    debug: !options.noDebug,
    unwind: !options.noUnwind,
    sources: !options.noSources,
  };
}

/**
 * Whether a parsed object passes all active filters.
 *
 * An object is included when it (1) has a real debug id, (2) matches the
 * `--type` filter, (3) matches the `--id` filter, and (4) carries at least one
 * wanted feature. Pure and side-effect free.
 *
 * @param obj - The parsed object metadata.
 * @param filters - The resolved filter set.
 */
export function objectPassesFilters(
  obj: DifObjectInfo,
  filters: DifFilters
): boolean {
  return (
    hasValidDebugId(obj) &&
    formatMatches(obj.fileFormat, filters.formats) &&
    idMatches(obj.debugId, filters.ids) &&
    featureMatches(obj, filters)
  );
}

/**
 * Recursively scan paths for candidate files.
 *
 * Each argument may be a file (kept as-is) or a directory. Directories are
 * walked recursively by the shared, well-tested {@link walkFiles} walker —
 * the same traversal foundation the DSN code-scanner uses. The walker is
 * configured to preserve this command's contract, which differs from the
 * walker's DSN-tuned defaults: debug files are large binaries that typically
 * live in `.gitignore`d build output (`build/`, `target/`, Xcode
 * `DerivedData`), so gitignore handling and the default build-output
 * skip-dirs are disabled, the 256 KB default size cap is lifted (size gating
 * happens later in {@link prepareDifs}, after the cheap format peek, so it can
 * accurately drive `oversizedCount`), and the unused `isBinary` classification
 * is turned off to avoid an extra head-read per file. Symlinks are followed;
 * cycles are detected by the walker via a visited inode set.
 *
 * Duplicate file paths (e.g. overlapping directory arguments, or a file passed
 * both explicitly and reached via a directory walk) are collapsed by absolute
 * path so each file is read and parsed at most once.
 *
 * A path that does not exist (or is unreadable) throws {@link ValidationError}.
 * Failures deep inside a directory tree are swallowed by the walker (a scanned
 * tree legitimately contains many unreadable/odd entries).
 *
 * @param paths - Files and/or directories to scan.
 * @returns File paths in scan order (absolute for walked entries; as-given for
 *   explicit file arguments), de-duplicated by absolute path.
 * @throws {ValidationError} If an explicit path does not exist or cannot be
 *   accessed.
 */
export async function scanPaths(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (filePath: string): void => {
    const key = resolve(filePath);
    if (!seen.has(key)) {
      seen.add(key);
      files.push(filePath);
    }
  };

  for (const path of paths) {
    const info = await statExplicitPath(path);
    if (info.isFile()) {
      add(path);
    } else if (info.isDirectory()) {
      for await (const entry of walkDebugFileDir(path)) {
        add(entry.absolutePath);
      }
    } else {
      // Sockets, FIFOs, devices, etc. are not debug files — skip them.
      log.debug(`Skipping non-file, non-directory path: ${path}`);
    }
  }

  return files;
}

/**
 * `stat` an explicit, user-supplied path argument, translating filesystem
 * errors into a {@link ValidationError}. Unlike entries discovered deep inside
 * a directory walk (which are silently skipped), a path the user named
 * explicitly must exist and be accessible.
 *
 * @param path - The explicit path argument.
 * @returns The path's `Stats`.
 * @throws {ValidationError} If the path does not exist or cannot be accessed.
 */
async function statExplicitPath(
  path: string
): Promise<Awaited<ReturnType<typeof stat>>> {
  try {
    return await stat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ValidationError(`Path '${path}' does not exist.`, "path");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new ValidationError(
        `Path '${path}' is not readable: ${code}.`,
        "path"
      );
    }
    throw new ValidationError(
      `Cannot access path '${path}': ${code ?? "unknown error"}.`,
      "path"
    );
  }
}

/**
 * Walk a directory for every regular file, using the shared {@link walkFiles}
 * walker configured for debug-file scanning.
 *
 * The options intentionally diverge from the walker's DSN-tuned defaults:
 * debug files are large binaries that typically live in `.gitignore`d build
 * output (`build/`, `target/`, Xcode `DerivedData`), so gitignore handling and
 * the default build-output skip-dirs are disabled, the 256 KB default size cap
 * is lifted (size gating happens later in {@link prepareDifs}, after the cheap
 * format peek, so it can accurately drive `oversizedCount`), and the unused
 * `isBinary` classification is turned off to avoid an extra head-read per file.
 * Symlinks are followed; the walker detects cycles via a visited inode set.
 *
 * @param dir - Absolute or relative directory path to walk.
 * @returns An async iterable of every file found beneath `dir`.
 */
function walkDebugFileDir(dir: string): AsyncIterable<WalkEntry> {
  return walkFiles({
    cwd: resolve(dir),
    respectGitignore: false,
    alwaysSkipDirs: [],
    maxFileSize: Number.POSITIVE_INFINITY,
    followSymlinks: true,
    classifyBinary: false,
  });
}

const PEEK_HEADER_BYTES = 4096;

/** A candidate file's recognised format and total size in bytes. */
type PeekResult = {
  /**
   * The container format detected from the header (canonical name, e.g.
   * `elf`, `macho`, `pe`). Never `unknown` (those return `null`).
   */
  format: string;
  /** Total file size in bytes (from the open descriptor's `stat`). */
  size: number;
};

/**
 * Peek at a file's header bytes for format detection — avoids reading the
 * whole file for large non-DIF data. Also reports the total file size (from
 * the open descriptor, so no extra `stat` syscall) so callers can gate on
 * format and size before fully reading the file. Returns `null` when the file
 * is unreadable, empty, or in an unrecognised format.
 */
async function peekHeader(path: string): Promise<PeekResult | null> {
  try {
    const fd = await open(path, "r");
    try {
      const { size } = await fd.stat();
      const buf = Buffer.alloc(PEEK_HEADER_BYTES);
      const { bytesRead } = await fd.read(buf, 0, PEEK_HEADER_BYTES, 0);
      const header =
        bytesRead < PEEK_HEADER_BYTES
          ? new Uint8Array(buf.subarray(0, bytesRead))
          : new Uint8Array(buf);
      if (header.length === 0) {
        return null;
      }
      const format = peekFormat(header);
      if (format === "unknown") {
        return null;
      }
      return { format, size };
    } finally {
      await fd.close();
    }
  } catch (err) {
    log.debug(`Skipping unreadable file: ${path}`, err);
    return null;
  }
}

/** Options controlling {@link prepareDifs} behavior. */
export type PrepareDifsOptions = {
  /**
   * Maximum size, in bytes, of a file to keep. Files larger than this are
   * skipped with a warning. `0` or omitted means no size gate. Mirrors the
   * legacy `dif_upload` `valid_size` check.
   */
  maxFileSize?: number;
  /**
   * Whether to look inside `.zip` archives for debug files. Defaults to `true`
   * (matching the legacy tool); set to `false` for `--no-zips`. Nested archives
   * are never recursed regardless of this setting.
   */
  scanZips?: boolean;
  /**
   * Cumulative uncompressed-extraction budget per `.zip` archive (and the
   * maximum container size), in bytes. Bounds peak decompression memory.
   * Defaults to {@link DEFAULT_MAX_ZIP_TOTAL_SIZE}; `0` disables the budget.
   */
  maxZipTotalSize?: number;
};

/** Result of {@link prepareDifs}: the uploadable files plus skip telemetry. */
export type PrepareDifsResult = {
  /** The files to upload, each with its matched objects and primary id. */
  prepared: PreparedDif[];
  /**
   * Number of recognised, format-matched **on-disk** debug files skipped solely
   * because they exceeded `maxFileSize`. Lets callers distinguish "nothing
   * found" from "everything found was too large" so they can fail with an
   * accurate message. Oversized entries inside `.zip` archives are deliberately
   * excluded — their format is unknown until decompression, so they warn
   * individually instead of driving this count.
   */
  oversizedCount: number;
};

/**
 * Read, parse, and filter candidate files into uploadable debug files.
 *
 * Each candidate is first cheaply inspected via a header-sized read +
 * {@link peekFormat}. Only files whose format is recognised are then fully
 * read and parsed — large non-DIF files (videos, archives) cost only the
 * header I/O and are never fully materialised.
 *
 * After a full read and parse, the file is kept only if at least one
 * contained object passes {@link objectPassesFilters}. Read/parse failures
 * are skipped with a debug log — a scanned tree contains many non-object files.
 *
 * @param paths - Candidate file paths (from {@link scanPaths}).
 * @param filters - The resolved filter set.
 * @param options - Optional size gate (see {@link PrepareDifsOptions}).
 * @returns The uploadable files plus the count of size-skipped files
 *   (see {@link PrepareDifsResult}).
 */
export async function prepareDifs(
  paths: string[],
  filters: DifFilters,
  options: PrepareDifsOptions = {}
): Promise<PrepareDifsResult> {
  const prepared: PreparedDif[] = [];
  const maxFileSize = options.maxFileSize ?? 0;
  const scanZips = options.scanZips ?? true;
  const maxZipTotalSize = options.maxZipTotalSize ?? DEFAULT_MAX_ZIP_TOTAL_SIZE;
  let oversizedCount = 0;

  for (const path of paths) {
    // A `.zip` archive is expanded in place; its entries replace the container,
    // which is itself never parsed as a DIF. A non-null result (even empty)
    // means the path was a `.zip` and is fully handled. `null` means "not a
    // zip" — fall through to normal file handling.
    if (scanZips) {
      const zipPrepared = await prepareZipDifs(
        path,
        filters,
        maxFileSize,
        maxZipTotalSize
      );
      // Oversized zip entries are advisory only — they warn per entry and
      // intentionally do NOT feed `oversizedCount`. That counter gates the
      // command's exit code, and a compressed entry's format is unknown until
      // it is inflated, so it cannot be attributed to the requested `--type`
      // the way the format-accurate on-disk gate below can. Counting them would
      // turn an unrelated oversized asset inside a `.zip` into a false
      // "all matched files too large" failure.
      if (zipPrepared) {
        prepared.push(...zipPrepared);
        continue;
      }
    }

    const { difs, oversized } = await prepareFileDif(
      path,
      filters,
      maxFileSize
    );
    if (oversized) {
      oversizedCount += 1;
    }
    prepared.push(...difs);
  }

  return { prepared, oversizedCount };
}

/**
 * Peek, format-gate, size-gate, and (when matching) read a single on-disk
 * candidate file into a {@link PreparedDif}.
 *
 * The cheap, header-derivable `--type` (format) filter runs before the size
 * gate so `oversized` is reported only for files of a requested format — an
 * oversized file of an unrequested type never triggers an "all matched files
 * too large" outcome. Per-object `--id`/feature filters require a full parse
 * and run in {@link readMatchedDif}.
 *
 * @param path - The candidate file path.
 * @param filters - The resolved filter set.
 * @param maxFileSize - Size gate in bytes (`0` disables it).
 * @returns The prepared DIFs (main plus any embedded PPDB; empty when none
 *   match) and whether the file was skipped for size.
 */
async function prepareFileDif(
  path: string,
  filters: DifFilters,
  maxFileSize: number
): Promise<{ difs: PreparedDif[]; oversized: boolean }> {
  const peeked = await peekHeader(path);
  if (!peeked) {
    return { difs: [], oversized: false };
  }
  const formatOk = formatMatches(peeked.format, filters.formats);
  // A managed PE keeps its debug info in an embedded Portable PDB. When the
  // filter accepts `portablepdb`, read PE files even if the `pe` format itself
  // is excluded, so the embedded PPDB can still be extracted; difFromBuffer then
  // drops the PE object and keeps only the matching PPDB.
  const readForPpdb =
    peeked.format === "pe" && formatMatches("portablepdb", filters.formats);
  if (!(formatOk || readForPpdb)) {
    return { difs: [], oversized: false };
  }
  // Gate on size before the full read so an oversized file is never buffered.
  if (maxFileSize > 0 && peeked.size > maxFileSize) {
    // Oversized drives the command's exit code only for files of a requested
    // format; a PE read solely to extract its PPDB is not itself a requested
    // match, so it must not inflate the oversized count.
    if (formatOk) {
      log.warn(
        `Skipping ${path}: size ${peeked.size} exceeds maximum file size ${maxFileSize}`
      );
      return { difs: [], oversized: true };
    }
    log.debug(
      `Skipping ${path} for embedded PPDB extraction: size ${peeked.size} exceeds maximum file size ${maxFileSize}`
    );
    return { difs: [], oversized: false };
  }
  // readMatchedDif reports an oversized embedded PPDB (of a requested type) so
  // it too drives the exit code, matching the on-disk size gate above.
  return await readMatchedDif(path, filters, maxFileSize);
}

/**
 * Parse an in-memory object buffer into a single {@link PreparedDif} when at
 * least one contained object passes the per-object filters, or `null` when the
 * buffer is empty, unparseable, or has no matching object. Pure (no I/O); parse
 * failures are logged at debug level.
 *
 * @param displayPath - Path used for naming and logs (an on-disk path or a
 *   synthetic `"<zip>/<entry>"` path).
 * @param content - The object bytes.
 * @param filters - The resolved filter set.
 */
function matchedDif(
  displayPath: string,
  content: Buffer,
  filters: DifFilters
): PreparedDif | null {
  if (content.length === 0) {
    return null;
  }

  let archive: DifArchiveInfo;
  try {
    archive = parseDebugFile(new Uint8Array(content));
  } catch (err) {
    log.debug(`Skipping unparseable file: ${displayPath}`, err);
    return null;
  }

  const matched = archive.objects.filter((obj) =>
    objectPassesFilters(obj, filters)
  );
  if (matched.length === 0) {
    return null;
  }

  return {
    path: displayPath,
    content,
    debugId: selectBundledObject(matched)?.debugId,
    objects: matched,
  };
}

/**
 * Extract a Portable PDB embedded in a managed PE buffer and return it as a
 * synthetic {@link PreparedDif}, or `null` when there is none, it is filtered
 * out, or it exceeds the size cap.
 *
 * A managed PE's debug info lives entirely in its embedded Portable PDB, so the
 * PE object itself usually carries no debug features and would be dropped by the
 * feature filter. The PPDB is therefore extracted independently of whether the
 * PE passed the filters (mirroring legacy `sentry-cli`), and the standalone PPDB
 * bytes are then run through the same per-object filters as any other file — so
 * it correctly honors `--type portablepdb`, feature, and `--id` filters — and
 * named `<base>.pdb` after the PE. Extraction/decompression errors are swallowed
 * (logged at debug level) so a malformed embed never aborts the scan.
 *
 * @param displayPath - The PE's path (used to derive the `.pdb` name and logs).
 * @param content - The PE object bytes.
 * @param filters - The resolved filter set (applied to the extracted PPDB).
 * @param maxFileSize - Size gate in bytes for the extracted PPDB (`0` disables).
 * @returns The extracted PPDB DIF (or `null`) and whether it was skipped for
 *   exceeding the size cap while a Portable PDB was a requested type (so the
 *   caller can fold it into the exit-driving oversized count).
 */
function embeddedPpdbDif(
  displayPath: string,
  content: Buffer,
  filters: DifFilters,
  maxFileSize: number
): { dif: PreparedDif | null; oversized: boolean } {
  // Only PE images can embed a Portable PDB. Cheap-gate on the header so the
  // vast majority of scanned files (ELF/Mach-O/Breakpad/...) skip the full
  // second parse that extraction would otherwise perform on every buffer.
  const header =
    content.length > PEEK_HEADER_BYTES
      ? new Uint8Array(content.subarray(0, PEEK_HEADER_BYTES))
      : new Uint8Array(content);
  if (peekFormat(header) !== "pe") {
    return { dif: null, oversized: false };
  }
  let extracted: ReturnType<typeof extractEmbeddedPpdb>;
  try {
    extracted = extractEmbeddedPpdb(new Uint8Array(content));
  } catch (err) {
    log.debug(
      `Could not extract embedded Portable PDB from ${displayPath}`,
      err
    );
    return { dif: null, oversized: false };
  }
  if (!extracted) {
    return { dif: null, oversized: false };
  }
  if (maxFileSize > 0 && extracted.ppdb.byteLength > maxFileSize) {
    log.warn(
      `Skipping embedded Portable PDB from ${displayPath}: size ${extracted.ppdb.byteLength} exceeds maximum file size ${maxFileSize}`
    );
    // Only count toward the oversized total when a Portable PDB is actually a
    // requested type; otherwise it would never have been uploaded anyway, so it
    // must not turn an empty queue into a spurious "files too large" failure.
    return {
      dif: null,
      oversized: formatMatches("portablepdb", filters.formats),
    };
  }
  const ext = extname(displayPath);
  const ppdbPath = `${displayPath.slice(0, displayPath.length - ext.length)}.pdb`;
  return {
    dif: matchedDif(ppdbPath, Buffer.from(extracted.ppdb), filters),
    oversized: false,
  };
}

/**
 * Parse an in-memory object buffer into uploadable debug files: the main DIF
 * (when it matches) plus, for managed PE assemblies, a separate Portable PDB
 * DIF extracted from the PE. Shared by the on-disk path ({@link readMatchedDif})
 * and in-memory ZIP entries ({@link difFromCandidateBuffer}).
 *
 * @param displayPath - Path used for naming and logs (an on-disk path or a
 *   synthetic `"<zip>/<entry>"` path).
 * @param content - The object bytes.
 * @param filters - The resolved filter set.
 * @param maxFileSize - Size gate for any extracted embedded PPDB (`0` disables).
 * @returns The prepared DIFs plus whether an extracted embedded PPDB of a
 *   requested type was skipped for size.
 */
function difFromBuffer(
  displayPath: string,
  content: Buffer,
  filters: DifFilters,
  maxFileSize: number
): { difs: PreparedDif[]; oversized: boolean } {
  const difs: PreparedDif[] = [];
  const main = matchedDif(displayPath, content, filters);
  if (main) {
    difs.push(main);
  }
  const ppdb = embeddedPpdbDif(displayPath, content, filters, maxFileSize);
  if (ppdb.dif) {
    difs.push(ppdb.dif);
  }
  return { difs, oversized: ppdb.oversized };
}

/**
 * Fully read and parse a single candidate file into uploadable debug files (the
 * main DIF plus any embedded Portable PDB), or an empty result when the file is
 * unreadable, unparseable, empty, or has no matching object. Read/parse failures
 * are logged at debug level — a scanned tree contains many non-object files.
 *
 * @param path - The candidate file path (already format- and size-gated).
 * @param filters - The resolved filter set.
 * @param maxFileSize - Size gate for any extracted embedded PPDB (`0` disables).
 * @returns The prepared DIFs plus whether an extracted embedded PPDB of a
 *   requested type was skipped for size.
 */
async function readMatchedDif(
  path: string,
  filters: DifFilters,
  maxFileSize: number
): Promise<{ difs: PreparedDif[]; oversized: boolean }> {
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch (err) {
    log.debug(`Skipping unreadable file: ${path}`, err);
    return { difs: [], oversized: false };
  }
  return difFromBuffer(path, content, filters, maxFileSize);
}

/**
 * Format-gate and parse an in-memory ZIP entry into uploadable debug files.
 *
 * Applies the cheap, header-derivable `--type` (format) filter before invoking
 * the full parser, mirroring the on-disk peek optimization so non-matching
 * entries are not handed to the WASM parser. PE entries are still parsed when
 * the filter accepts `portablepdb`, so an embedded Portable PDB can be extracted
 * even if the `pe` format itself is excluded. Returns an empty array for
 * unrecognised, non-matching, or non-object entries.
 *
 * @param displayPath - Synthetic `"<zip>/<entry>"` path for naming and logs.
 * @param content - The decompressed entry bytes (already size-gated).
 * @param filters - The resolved filter set.
 * @param maxFileSize - Size gate for any extracted embedded PPDB (`0` disables).
 */
function difFromCandidateBuffer(
  displayPath: string,
  content: Buffer,
  filters: DifFilters,
  maxFileSize: number
): PreparedDif[] {
  if (content.length === 0) {
    return [];
  }
  const header =
    content.length > PEEK_HEADER_BYTES
      ? new Uint8Array(content.subarray(0, PEEK_HEADER_BYTES))
      : new Uint8Array(content);
  const format = peekFormat(header);
  if (format === "unknown") {
    return [];
  }
  const formatOk = formatMatches(format, filters.formats);
  const readForPpdb =
    format === "pe" && formatMatches("portablepdb", filters.formats);
  if (!(formatOk || readForPpdb)) {
    return [];
  }
  // A ZIP entry's oversized embedded PPDB stays advisory (not counted), matching
  // how oversized ZIP entries are handled elsewhere in this file.
  return difFromBuffer(displayPath, content, filters, maxFileSize).difs;
}

/**
 * Expand a `.zip` archive at `path` into prepared debug files.
 *
 * Returns `null` when `path` is not a ZIP (the caller then handles it as a
 * normal file) or when the container is skipped wholesale (too large / malformed
 * — see {@link readZipDifEntries}). Otherwise extracts each entry (bounded by
 * `maxFileSize` and `maxTotalSize`) and runs it through
 * {@link difFromCandidateBuffer}. Nested archives are not recursed.
 *
 * Oversized entries are not surfaced here: they warn per entry inside
 * {@link readZipDifEntries} and are deliberately excluded from the exit-driving
 * oversized count (their format is unknown pre-decompression).
 *
 * @param path - The candidate path (possibly a `.zip`).
 * @param filters - The resolved filter set.
 * @param maxFileSize - Per-entry size gate passed through to entry extraction.
 * @param maxTotalSize - Cumulative extraction budget / container size cap.
 * @returns The matched debug files (possibly empty), or `null` when not a ZIP.
 */
async function prepareZipDifs(
  path: string,
  filters: DifFilters,
  maxFileSize: number,
  maxTotalSize: number
): Promise<PreparedDif[] | null> {
  const zip = await readZipDifEntries(path, { maxFileSize, maxTotalSize });
  if (!zip) {
    return null;
  }
  const prepared: PreparedDif[] = [];
  for (const entry of zip.entries) {
    prepared.push(
      ...difFromCandidateBuffer(entry.path, entry.content, filters, maxFileSize)
    );
  }
  return prepared;
}
