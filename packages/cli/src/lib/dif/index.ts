/**
 * Debug Information File (DIF) parser.
 *
 * Thin TypeScript API over the `@sentry/symbolic` WASM module. Parses object
 * files (Mach-O/dSYM, ELF, PE/PDB, Portable PDB, WASM, Breakpad, SourceBundle)
 * entirely in-process — no native binary and no dependency on the legacy Rust
 * `sentry-cli`.
 *
 * `@sentry/symbolic` is a build-time (dev) dependency: the JS glue is bundled
 * by esbuild, and the `.wasm` bytes are loaded lazily on first use:
 *   - SEA binary: embedded asset via `node:sea.getRawAsset()`
 *   - npm bundle: the `.wasm` copied next to the bundle at build time
 *   - dev (tsx): resolved from the installed `@sentry/symbolic` package
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  Archive,
  il2cppLineMapping,
  initSync,
  SourceBundleWriter,
} from "@sentry/symbolic";
import { logger } from "../logger.js";
import { getSeaRawAsset } from "../sea-assets.js";

const log = logger.withTag("dif");
const _require = createRequire(import.meta.url);

/**
 * SEA asset key for the embedded WASM bytes. Must match the `--assets`
 * argument passed to fossilize in `script/build.ts`.
 */
const DIF_WASM_ASSET_KEY = "dist-build/symbolic_bg.wasm";

/**
 * Package subpath for the WASM file, resolved at runtime only in dev (where
 * `@sentry/symbolic` is installed). It is marked `external` in the esbuild
 * configs (build.ts/bundle.ts), so the bundler never resolves/inlines it.
 */
const SYMBOLIC_WASM_SUBPATH = "@sentry/symbolic/symbolic_bg.wasm";

/** Per-object metadata extracted from a debug information file. */
export type DifObjectInfo = {
  /** Debug identifier (UUID, possibly with an age/appendix suffix). */
  debugId: string;
  /** Code identifier (GNU build-id, PE timestamp+size, etc.), if present. */
  codeId: string | null;
  /** CPU architecture (canonical name, e.g. `x86_64`, `arm64`, `unknown`). */
  arch: string;
  /** Object file format (canonical name, e.g. `elf`, `macho`, `pdb`, `pe`, `breakpad`). */
  fileFormat: string;
  /** Object kind (canonical name, e.g. `exe`, `lib`, `dbg`, `src`). */
  kind: string;
  /** Whether the object contains a symbol table. */
  hasSymbols: boolean;
  /** Whether the object contains debug info (DWARF/CodeView/...). */
  hasDebugInfo: boolean;
  /** Whether the object contains stack-unwind info. */
  hasUnwindInfo: boolean;
  /** Whether the object contains (or embeds) source files. */
  hasSources: boolean;
};

/** Result of parsing a debug information file (archive of one or more objects). */
export type DifArchiveInfo = {
  /** Container format of the archive (canonical name). */
  fileFormat: string;
  /** Objects contained in the archive (e.g. fat Mach-O has one per arch slice). */
  objects: DifObjectInfo[];
};

let initialized = false;

/**
 * Load the WASM bytes for the current runtime mode.
 *
 * In a SEA binary the bytes come from the embedded asset (fatal on error — no
 * fallback exists). In the npm bundle the `.wasm` is a sibling copied at build
 * time. In dev it is resolved from the installed `@sentry/symbolic` package.
 */
function loadWasmBytes(): Uint8Array {
  const seaAsset = getSeaRawAsset(DIF_WASM_ASSET_KEY);
  if (seaAsset) {
    return seaAsset;
  }
  const sibling = new URL("./vendor/symbolic_bg.wasm", import.meta.url);
  if (existsSync(sibling)) {
    return readFileSync(sibling);
  }
  // dev: resolve from the installed @sentry/symbolic package.
  try {
    return readFileSync(_require.resolve(SYMBOLIC_WASM_SUBPATH));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not locate the DIF parser WASM (${SYMBOLIC_WASM_SUBPATH}). ` +
        `Expected it next to the bundle or via @sentry/symbolic: ${msg}`
    );
  }
}

/** Instantiate the WASM module once, lazily. */
function ensureInitialized(): void {
  if (initialized) {
    return;
  }
  initSync({ module: loadWasmBytes() });
  initialized = true;
}

/**
 * Parse a debug information file from an in-memory buffer.
 *
 * @param data - The full contents of the object file.
 * @returns Archive metadata including each contained object's debug id,
 *   code id, architecture, kind, and feature flags.
 * @throws If the buffer cannot be parsed as a known object format.
 */
export function parseDebugFile(data: Uint8Array): DifArchiveInfo {
  ensureInitialized();
  // `using` frees the WASM handle when this returns; the mapped result holds
  // only plain values, so the archive is safe to release here.
  using archive = new Archive(data);
  return {
    fileFormat: archive.fileFormat,
    objects: archive.objects().map((o) => ({
      debugId: o.debugId,
      codeId: o.codeId ?? null,
      arch: o.arch,
      fileFormat: o.fileFormat,
      kind: o.kind,
      hasSymbols: o.hasSymbols,
      hasDebugInfo: o.hasDebugInfo,
      hasUnwindInfo: o.hasUnwindInfo,
      hasSources: o.hasSources,
    })),
  };
}

/**
 * Detect the object file format without a full parse.
 *
 * @param data - The (possibly partial) contents of the object file.
 * @returns The detected format name (canonical, e.g. `elf`, `macho`, `unknown`).
 */
export function peekFormat(data: Uint8Array): string {
  ensureInitialized();
  return Archive.peek(data) ?? "unknown";
}

/** An embedded Portable PDB extracted from a managed PE object. */
export type EmbeddedPpdbResult = {
  /** The decompressed, standalone Portable PDB bytes. */
  ppdb: Uint8Array;
  /** Debug id of the PE the Portable PDB was embedded in (its advisory id). */
  debugId: string;
};

/**
 * Extract a Portable PDB embedded inside a managed Windows PE (.NET assembly).
 *
 * Managed PE images can carry their Portable PDB debug companion inline (debug
 * directory entry type 17, deflate-compressed). This narrows each object in the
 * archive to a PE via `ObjectFile.asPe()` and, for the first PE that embeds a
 * Portable PDB, decompresses and returns those bytes together with that PE's
 * debug id. The returned bytes are themselves a standalone Portable PDB that can
 * be parsed and uploaded as a separate debug information file.
 *
 * Non-PE objects (and PEs without an embedded PPDB) are skipped, so this is safe
 * to call unconditionally on any object file. A decompression/extraction error
 * for an individual object is swallowed (logged at debug level) and treated as
 * "no embedded PPDB", mirroring legacy `sentry-cli`, where a failed extraction
 * never aborts the surrounding upload.
 *
 * @param data - The full contents of the object file (archive).
 * @returns The embedded Portable PDB bytes plus the PE's debug id, or `null`
 *   when no object in the archive embeds a Portable PDB.
 * @throws If the buffer cannot be parsed as a known object format.
 */
export function extractEmbeddedPpdb(
  data: Uint8Array
): EmbeddedPpdbResult | null {
  ensureInitialized();
  using archive = new Archive(data);
  for (const object of archive.objects()) {
    using pe = object.asPe();
    if (!pe) {
      continue;
    }
    try {
      const ppdb = pe.embeddedPpdb();
      if (ppdb) {
        return { ppdb, debugId: object.debugId };
      }
    } catch (err) {
      log.debug(
        `Failed to extract embedded Portable PDB for ${object.debugId}`,
        err
      );
    }
  }
  return null;
}

/**
 * Select the single object that source-bundling operates on: the first object
 * that carries debug info, falling back to the first object in the archive.
 *
 * Fat archives (e.g. universal Mach-O) contain one object per arch slice, but
 * {@link createSourceBundle} bundles only one slice. Both the bundler and the
 * `print-sources` preview share this rule so they stay consistent about which
 * slice is the canonical one.
 *
 * @param objects - Objects in the archive (in archive order).
 * @returns The selected object, or `undefined` if the archive has no objects.
 */
export function selectBundledObject<T extends { hasDebugInfo: boolean }>(
  objects: readonly T[]
): T | undefined {
  return objects.find((object) => object.hasDebugInfo) ?? objects[0];
}

/** Result of building a source bundle from a debug information file. */
export type SourceBundleResult = {
  /** The source bundle ZIP bytes, or `null` if the bundle would be empty. */
  bundle: Uint8Array | null;
  /** Debug id of the object the bundle was built for, or `null` if the file has no objects. */
  debugId: string | null;
  /** Number of source files included in the bundle. */
  fileCount: number;
  /** Total number of objects in the archive (a bundle is built for one of them). */
  objectCount: number;
};

/**
 * Build a source bundle (a ZIP archive) from the source files referenced by a
 * debug information file.
 *
 * The object's debug info is walked for referenced source paths; for each,
 * `readSource` is invoked to supply that file's contents. Return `null` from
 * `readSource` to skip a path that isn't available locally. The bundle is built
 * entirely in memory; nothing is read from disk by this function itself.
 *
 * The bundle is built for the single object chosen by {@link selectBundledObject}
 * (first object with debug info, falling back to the first object), which matches
 * the single-object debug files this is used for; fat archives with multiple
 * debug-info slices are not split here.
 *
 * @param data - The full contents of the debug information file.
 * @param objectName - Name stamped on the bundle (typically the input file name).
 * @param readSource - Supplies source content for a referenced path, or `null` to skip.
 *   Invoked synchronously, so it must read synchronously (e.g. `readFileSync`).
 * @param options - Optional behavior flags.
 * @param options.collectIl2cppSources - When `true`, also include the C# source
 *   files referenced by Unity IL2CPP `source_info` markers in the object's
 *   generated C++ (used together with `--il2cpp-mapping`).
 * @returns The bundle bytes (or `null` if empty), the object's debug id, and the
 *   number of files included.
 * @throws If the buffer cannot be parsed, or if `readSource` throws.
 */
export function createSourceBundle(
  data: Uint8Array,
  objectName: string,
  readSource: (path: string) => Uint8Array | null,
  options?: { collectIl2cppSources?: boolean }
): SourceBundleResult {
  ensureInitialized();
  using archive = new Archive(data);
  const objects = archive.objects();
  const objectCount = objects.length;
  const object = selectBundledObject(objects);
  if (!object) {
    return { bundle: null, debugId: null, fileCount: 0, objectCount };
  }

  let fileCount = 0;
  const writer = new SourceBundleWriter();
  // Must be set before the one-shot writeObject() consumes the writer.
  if (options?.collectIl2cppSources) {
    writer.collectIl2cppSources = true;
  }
  // The filter runs before each file; we include everything the object
  // references and let the provider decide availability (returning null skips).
  const filter = (_path: string): boolean => true;
  const provider = (path: string): Uint8Array | null => {
    const content = readSource(path);
    if (content !== null) {
      fileCount += 1;
    }
    return content;
  };

  const bundle =
    writer.writeObject(object, objectName, filter, provider) ?? null;
  return { bundle, debugId: object.debugId, fileCount, objectCount };
}

/** Result of computing a Unity IL2CPP line mapping for a debug information file. */
export type Il2cppMappingResult = {
  /** The serialized IL2CPP C++→C# line-mapping JSON document bytes. */
  mapping: Uint8Array;
  /** Debug id of the object the mapping was computed for. */
  debugId: string;
};

/**
 * Compute a Unity IL2CPP C++→C# line mapping for a debug information file.
 *
 * Unity's IL2CPP transpiles C# to C++, embedding `//<source_info:File.cs:line>`
 * markers in the generated C++. This enumerates the C++ source files referenced
 * by the object's debug info; for each, `readSource` supplies that file's
 * contents (return `null` to skip a path not available locally). The markers are
 * parsed into a C++→C# mapping serialized as a JSON document — the format Sentry
 * consumes for IL2CPP symbolication — which can be uploaded as a separate DIF.
 *
 * The mapping is computed for the object identified by `targetDebugId` when
 * given (so the returned debug id always matches the object the mapping
 * describes), otherwise for the single object chosen by
 * {@link selectBundledObject}, matching {@link createSourceBundle}. Nothing is
 * read from disk by this function itself; `readSource` performs all I/O.
 *
 * @param data - The full contents of the debug information file.
 * @param readSource - Supplies C++ source content for a referenced path, or
 *   `null` to skip. Invoked synchronously (e.g. `readFileSync`).
 * @param targetDebugId - Debug id of the specific object to map (typically the
 *   filter-matched primary). When omitted or not found, falls back to
 *   {@link selectBundledObject}.
 * @returns The serialized mapping bytes plus the mapped object's debug id, or
 *   `null` when the archive has no objects or the object references no IL2CPP
 *   `source_info` markers (an empty mapping).
 * @throws If the buffer cannot be parsed, or if `readSource` throws.
 */
export function createIl2cppLineMapping(
  data: Uint8Array,
  readSource: (path: string) => Uint8Array | null,
  targetDebugId?: string
): Il2cppMappingResult | null {
  ensureInitialized();
  using archive = new Archive(data);
  const objects = archive.objects();
  // Map the caller's targeted object so the mapping content always corresponds
  // to the debug id the DIF advertises; without this a fat archive plus `--id`
  // could stamp one slice's id onto another slice's line mappings.
  const object =
    (targetDebugId
      ? objects.find((candidate) => candidate.debugId === targetDebugId)
      : undefined) ?? selectBundledObject(objects);
  if (!object) {
    return null;
  }
  const mapping = il2cppLineMapping(
    object,
    (path: string) => readSource(path) ?? undefined
  );
  if (!mapping) {
    return null;
  }
  return { mapping, debugId: object.debugId };
}

/** A source file referenced by an object, with any resolved descriptor metadata. */
export type DifSourceFile = {
  /** Absolute path recorded in the debug info. */
  path: string;
  /** Whether the path resolved to a descriptor (embedded contents or a source link). */
  resolved: boolean;
  /**
   * The descriptor's source-file type (e.g. `source`, `minified_source`,
   * `source_map`), or `null` when the path did not resolve to a descriptor.
   */
  type: string | null;
  /** Source link URL carried by the descriptor, if any. */
  url: string | null;
  /** Debug id associated with the source, if any. */
  debugId: string | null;
  /** Source map URL reference, if any. */
  sourceMappingUrl: string | null;
};

/** The source files referenced by a single object within a debug file. */
export type DifObjectSources = {
  /** The object's debug identifier. */
  debugId: string;
  /** The object file format (e.g. `elf`, `pdb`). */
  fileFormat: string;
  /**
   * Whether the object carries debug info. Mirrors the slice-selection used by
   * {@link createSourceBundle} so callers can preview exactly the object that
   * `bundle-sources` would bundle.
   */
  hasDebugInfo: boolean;
  /** Source files referenced by the object's debug info. */
  files: DifSourceFile[];
  /**
   * Error message if opening the object's debug session or enumerating its
   * source files failed, otherwise `null`. When set, `files` is empty because
   * enumeration aborted — this is distinct from an object that genuinely
   * references no sources (where this stays `null`).
   */
  enumerationError: string | null;
};

/** All objects and the source files they reference, for a debug file. */
export type DifSourcesInfo = {
  objects: DifObjectSources[];
};

/**
 * Enumerate the source files referenced by a debug information file.
 *
 * For each object, opens a debug session and lists every referenced source
 * path, resolving each to its descriptor (embedded contents or a source link)
 * when available. Nothing is read from the local filesystem here.
 *
 * @param data - The full contents of the debug information file.
 * @returns Per-object lists of referenced source files with descriptor metadata.
 * @throws If the buffer cannot be parsed.
 */
export function listSources(data: Uint8Array): DifSourcesInfo {
  ensureInitialized();
  using archive = new Archive(data);
  const objects = archive.objects().map((object) => {
    const files: DifSourceFile[] = [];
    let enumerationError: string | null = null;
    try {
      const session = object.debugSession();
      for (const file of session.files()) {
        const path = file.abs_path_str;
        const descriptor = session.sourceByPath(path);
        // Only cheap descriptor metadata is read here. Reading `contents`
        // would copy the full source text across the wasm/JS boundary — and
        // re-encode the Rust UTF-8 string to a JS UTF-16 string — for every
        // referenced file, which listing references never needs.
        files.push({
          path,
          resolved: descriptor !== undefined,
          type: descriptor?.type ?? null,
          url: descriptor?.url ?? null,
          debugId: descriptor?.debugId ?? null,
          sourceMappingUrl: descriptor?.sourceMappingUrl ?? null,
        });
      }
    } catch (err) {
      // One slice failing to enumerate must not abort the whole listing, but
      // the failure is recorded so callers can distinguish it from an object
      // that simply references no sources. Discard any entries collected before
      // the error so `files` stays empty when enumeration aborted (per the
      // DifObjectSources contract) — a partial list paired with an error would
      // mislead consumers and be hidden by the human formatter.
      files.length = 0;
      enumerationError = err instanceof Error ? err.message : String(err);
      log.debug(`Failed to enumerate sources for ${object.debugId}`, err);
    }
    return {
      debugId: object.debugId,
      fileFormat: object.fileFormat,
      hasDebugInfo: object.hasDebugInfo,
      files,
      enumerationError,
    };
  });
  return { objects };
}
