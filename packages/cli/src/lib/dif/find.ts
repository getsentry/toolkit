/**
 * Locate debug-information files on disk by debug ID.
 *
 * Backs `debug-files find`: walks a set of directories and, for each file,
 * cheaply peeks its header to detect a debug-file format, then fully parses
 * only candidates whose format is wanted, matching their embedded debug IDs
 * against the requested set. ProGuard mappings (plain-text, no magic) are
 * matched separately by computing their deterministic UUID.
 *
 * Mirrors the legacy Rust `debug_files find` command.
 */

import { open, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { logger } from "../logger.js";
import { computeProguardUuid } from "../proguard.js";
import { walkFiles } from "../scan/walker.js";
import { parseDebugFile, peekFormat } from "./index.js";
import { normalizeDebugId } from "./scan.js";

/** Text mapping files larger than this are never treated as ProGuard files. */
const MAX_MAPPING_FILE = 32 * 1024 * 1024;

/** Bytes read from each file's header for format detection. */
const PEEK_BYTES = 4096;

/** DIF types accepted by `debug-files find` (`--type`). */
export const FIND_DIF_TYPES: readonly string[] = [
  "dsym",
  "elf",
  "pe",
  "pdb",
  "portablepdb",
  "sourcebundle",
  "breakpad",
  "proguard",
  "jvm",
  "wasm",
];

/** Map a requested type to the object format `peekFormat` reports. */
const TYPE_TO_FORMAT: Readonly<Record<string, string>> = {
  dsym: "macho",
  elf: "elf",
  pe: "pe",
  pdb: "pdb",
  portablepdb: "portablepdb",
  sourcebundle: "sourcebundle",
  jvm: "sourcebundle",
  breakpad: "breakpad",
  wasm: "wasm",
};

/** Map a detected object format back to a display DIF type. */
const FORMAT_TO_TYPE: Readonly<Record<string, string>> = {
  macho: "dsym",
  elf: "elf",
  pe: "pe",
  pdb: "pdb",
  portablepdb: "portablepdb",
  sourcebundle: "sourcebundle",
  breakpad: "breakpad",
  wasm: "wasm",
};

/** A located debug file matching a requested id. */
export type DifMatch = {
  /** DIF type (e.g. `dsym`, `elf`, `proguard`). */
  type: string;
  /** The matched debug id (as requested/normalized). */
  id: string;
  /** Absolute path to the file. */
  path: string;
};

/** A requested id that was not located, with a heuristic hint. */
export type MissingId = {
  /** The normalized debug id. */
  id: string;
  /** A guess at the likely file type based on the id's shape. */
  hint: string;
};

/** Outcome of a {@link findDebugFiles} search. */
export type FindResult = {
  /** Located files (in discovery order). */
  matches: DifMatch[];
  /** Requested ids that were not located. */
  missing: MissingId[];
};

/** Options for {@link findDebugFiles}. */
export type FindOptions = {
  /** Requested debug ids (raw; normalized internally). */
  ids: string[];
  /** Requested DIF types; when omitted or empty, all types are considered. */
  types?: string[];
  /** Directories (or files) to search recursively. */
  paths: string[];
  /** Optional progress callback (files matched so far, current file name). */
  onProgress?: (matched: number, current: string) => void;
};

/**
 * Heuristic hint for a not-found id, from the shape of the id.
 *
 * @param normalized - A normalized debug id.
 */
export function idHint(normalized: string): string {
  const parts = normalized.split("-");
  if (parts.length > 5) {
    return "likely PDB";
  }
  const version = parts[2]?.[0];
  if (version === "5") {
    return "likely Proguard";
  }
  if (version === "3") {
    return "likely dSYM";
  }
  if (version === "1" || version === "2" || version === "4") {
    return "unknown";
  }
  return "likely ELF Debug";
}

/** Whether a normalized id is shaped like a ProGuard (UUIDv5) mapping id. */
function isProguardId(normalized: string): boolean {
  return normalized.split("-")[2]?.[0] === "5";
}

/**
 * Choose the display label for a `sourcebundle`-format match. Both `sourcebundle`
 * and `jvm` map to that format, so label a match with whichever the user asked
 * for, preferring `sourcebundle`.
 */
function sourcebundleDisplayType(wantedTypes: readonly string[]): string {
  const lowered = wantedTypes.map((t) => t.toLowerCase());
  if (!lowered.includes("sourcebundle") && lowered.includes("jvm")) {
    return "jvm";
  }
  return "sourcebundle";
}

/** Mutable search state threaded through the walk. */
type SearchState = {
  /** Ids still being searched for (normalized). */
  remaining: Set<string>;
  /** Ids matched only by a breakpad file (still considered missing). */
  breakpadFound: Set<string>;
  /** Wanted object formats (peekFormat names). */
  formats: Set<string>;
  /** Display type to use for a `sourcebundle` match (`sourcebundle` or `jvm`). */
  sourcebundleType: string;
  /** Whether ProGuard mappings should be considered. */
  wantProguard: boolean;
  /** Accumulated matches. */
  matches: DifMatch[];
};

/** Find the remaining id that matches `debugId`, or undefined. */
function matchRemaining(
  state: SearchState,
  debugId: string
): string | undefined {
  const normalized = normalizeDebugId(debugId);
  return state.remaining.has(normalized) ? normalized : undefined;
}

/** Try to match a plain-text ProGuard mapping file. */
async function tryProguard(
  path: string,
  size: number,
  state: SearchState
): Promise<void> {
  if (
    !state.wantProguard ||
    extname(path).toLowerCase() !== ".txt" ||
    size >= MAX_MAPPING_FILE
  ) {
    return;
  }
  // Only worth hashing when a ProGuard-shaped id is still sought.
  if (![...state.remaining].some(isProguardId)) {
    return;
  }
  let uuid: string;
  try {
    uuid = computeProguardUuid(await readFile(path));
  } catch (error) {
    logger.debug(
      `Skipping ProGuard candidate ${path}: read/hash failed`,
      error
    );
    return;
  }
  const matched = matchRemaining(state, uuid);
  if (matched) {
    state.matches.push({ type: "proguard", id: matched, path });
    satisfy(state, matched);
  }
}

/** Mark an id as located by a real debug file (clears any breakpad-only flag). */
function satisfy(state: SearchState, id: string): void {
  state.remaining.delete(id);
  // A real match supersedes a prior breakpad-only match for the same id, so the
  // id is no longer "missing" (the legacy CLI failed to clear this).
  state.breakpadFound.delete(id);
}

/** Try to match an object debug file (ELF/Mach-O/PE/PDB/breakpad/…). */
async function tryObject(
  path: string,
  size: number,
  state: SearchState
): Promise<void> {
  let format: string;
  try {
    const fd = await open(path, "r");
    try {
      const buf = Buffer.alloc(Math.min(PEEK_BYTES, size));
      await fd.read(buf, 0, buf.length, 0);
      format = peekFormat(buf);
    } finally {
      await fd.close();
    }
  } catch (error) {
    logger.debug(`Skipping ${path}: failed to peek format`, error);
    return;
  }
  if (!state.formats.has(format)) {
    return;
  }
  const displayType =
    format === "sourcebundle"
      ? state.sourcebundleType
      : (FORMAT_TO_TYPE[format] ?? format);
  let objects: { debugId: string }[];
  try {
    objects = parseDebugFile(await readFile(path)).objects;
  } catch (error) {
    logger.debug(`Skipping ${path}: failed to parse debug file`, error);
    return;
  }
  for (const obj of objects) {
    const matched = matchRemaining(state, obj.debugId);
    if (!matched) {
      continue;
    }
    state.matches.push({ type: displayType, id: matched, path });
    // A breakpad file is reported but does not satisfy the request: the id
    // stays "missing" (a breakpad symbol is not the real debug file).
    if (format === "breakpad") {
      state.breakpadFound.add(matched);
    } else {
      satisfy(state, matched);
    }
  }
}

/** Resolve a search root to the list of files to inspect. */
async function* walkPath(path: string): AsyncGenerator<{
  absolutePath: string;
  size: number;
}> {
  const abs = resolve(path);
  const info = await stat(abs).catch(() => null);
  if (!info) {
    return;
  }
  if (info.isFile()) {
    yield { absolutePath: abs, size: info.size };
    return;
  }
  if (!info.isDirectory()) {
    return;
  }
  yield* walkFiles({
    cwd: abs,
    hidden: true,
    followSymlinks: false,
    respectGitignore: false,
    alwaysSkipDirs: [],
    maxFileSize: Number.POSITIVE_INFINITY,
    classifyBinary: false,
  });
}

/**
 * Search `paths` for debug files matching the requested ids.
 *
 * Object formats are detected by a cheap header peek and only fully parsed when
 * wanted; ProGuard mappings are matched by computing their UUID. The search
 * stops early once every id is located (breakpad-only matches never satisfy an
 * id, mirroring the legacy CLI).
 */
export async function findDebugFiles(opts: FindOptions): Promise<FindResult> {
  const wantedTypes =
    opts.types && opts.types.length > 0 ? opts.types : FIND_DIF_TYPES;
  const state: SearchState = {
    remaining: new Set(opts.ids.map(normalizeDebugId)),
    breakpadFound: new Set(),
    formats: new Set(
      wantedTypes
        .map((t) => TYPE_TO_FORMAT[t.toLowerCase()])
        .filter((f): f is string => Boolean(f))
    ),
    sourcebundleType: sourcebundleDisplayType(wantedTypes),
    wantProguard: wantedTypes.some((t) => t.toLowerCase() === "proguard"),
    matches: [],
  };

  const seen = new Set<string>();
  for (const path of opts.paths) {
    const abs = resolve(path);
    if (seen.has(abs)) {
      continue;
    }
    seen.add(abs);
    for await (const entry of walkPath(path)) {
      if (state.remaining.size === 0) {
        break;
      }
      opts.onProgress?.(state.matches.length, entry.absolutePath);
      await tryProguard(entry.absolutePath, entry.size, state);
      await tryObject(entry.absolutePath, entry.size, state);
    }
    if (state.remaining.size === 0) {
      break;
    }
  }

  // Breakpad-only matches are reported but still counted as missing.
  const missingIds = new Set([...state.remaining, ...state.breakpadFound]);
  const missing: MissingId[] = [...missingIds].map((id) => ({
    id,
    hint: idHint(id),
  }));
  return { matches: state.matches, missing };
}
