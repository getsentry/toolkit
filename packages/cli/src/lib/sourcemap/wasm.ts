/**
 * Debug IDs for WebAssembly modules and their sourcemaps.
 *
 * Emscripten's `-gsource-map` emits `app.wasm` next to `app.wasm.map`, a plain
 * Source Map v3 file. Sentry identifies a wasm module by the `build_id` custom
 * section, which events report as `debug_meta.images[].debug_id`, and matches
 * uploaded maps by the `debug_id` field inside the map JSON. This module puts
 * the same id on both sides so the two artifacts join up.
 *
 * The module's `build_id` is the source of truth: it is what the running
 * module reports, and unlike the JS path there is nothing to derive from
 * content. A map that disagrees is corrected, not adopted.
 *
 * The wasm path deliberately shares nothing with JS injection beyond
 * discovery settings. A module is binary — it gets no `//# debugId=` comment,
 * no runtime snippet, and its map needs no `mappings` offset.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type ignore from "ignore";
import { logger } from "../logger.js";
import { walkFiles } from "../scan/index.js";
import {
  BUILD_ID_SECTION,
  parseSections,
  WasmParseError,
} from "../wasm/binary.js";
import {
  buildIdFromSections,
  debugIdFromBuildId,
  formatBuildId,
} from "../wasm/build-id.js";
import { isDebugCompanionPath } from "../wasm/prepare.js";
import { ensureBuildIdOnDisk } from "../wasm/stamp.js";
import { readSourcemapFile, setSourcemapDebugId } from "./debug-id.js";
import {
  type DiscoveryDiagnostic,
  type PathFilter,
  relativePosix,
  SOURCEMAP_SKIP_DIRS,
} from "./inject.js";

const log = logger.withTag("sourcemap.wasm");

/**
 * Extensions scanned when looking for wasm modules. Never user-configurable:
 * `--ext` selects JavaScript flavours, and a wasm module is always `.wasm`.
 */
const WASM_EXTENSIONS: ReadonlySet<string> = new Set([".wasm"]);

/**
 * Extensions scanned when counting artifacts for the zero-pairs diagnostic.
 * Covers `.map` so an orphaned `app.wasm.map` — a map whose module is not in
 * the directory — is attributed to wasm instead of being left in the JS tally.
 */
const WASM_DIAGNOSTIC_EXTENSIONS: ReadonlySet<string> = new Set([
  ".wasm",
  ".map",
]);

/** A WebAssembly module and the sourcemap sitting next to it. */
export type WasmPair = {
  /** Absolute path to the `.wasm` module. */
  wasmPath: string;
  /** Absolute path to the companion `.wasm.map`. */
  mapPath: string;
};

/** Outcome of reconciling one module with its sourcemap. */
export type WasmSyncResult = {
  /** Absolute path to the `.wasm` module. */
  wasmPath: string;
  /** Absolute path to the companion `.wasm.map`. */
  mapPath: string;
  /**
   * The debug ID both files now carry. Absent only when a dry run declined to
   * stamp a module that had no `build_id`, so the id is not yet decided.
   */
  debugId?: string;
  /** Whether the map was rewritten (in a dry run: would be). */
  mapWritten: boolean;
  /**
   * Whether the module was given a `build_id` it did not have (in a dry run:
   * would be).
   */
  moduleStamped: boolean;
  /**
   * Why the pair was left alone, when it was. A skipped pair has no debug ID,
   * wrote nothing, and is not uploaded.
   */
  skipped?: string;
};

/**
 * Which modules discovery considers, mirroring the JS discovery settings so
 * `--ignore`, `--ignore-file`, and a glob upload target narrow wasm the same
 * way they narrow JS.
 */
export type WasmDiscoveryOptions = {
  /** Gitignore-style matcher built from `--ignore` / `--ignore-file`. */
  ignoreMatcher?: ReturnType<typeof ignore>;
  /** Glob filter from a `sourcemap upload` target. */
  include?: PathFilter;
};

/** Whether reconciling a pair is allowed to write. */
export type WasmSyncOptions = {
  /** Report what would change without touching either file. */
  dryRun?: boolean;
};

/**
 * Give a wasm module and its sourcemap a shared debug ID.
 *
 * Reads the module's `build_id`, stamping a fresh one when it has none, then
 * writes that id onto the map. Idempotent: a map already carrying the id is
 * left byte-identical, and a module that already has a `build_id` is never
 * rewritten. A pair that can't be handled (not a module, a map that isn't
 * JSON, an unreadable `build_id`, files it can't write) is skipped with a
 * warning instead of failing the run.
 *
 * @param pair - The module and its companion map
 * @param options - Stamping options
 * @returns What the pair now carries, and what was written
 */
export async function syncWasmSourcemap(
  pair: WasmPair,
  options: WasmSyncOptions = {},
): Promise<WasmSyncResult> {
  try {
    return await reconcilePair(pair, options);
  } catch (error) {
    const reason = skipReason(error);
    if (!reason) {
      throw error;
    }
    return skip(pair, reason);
  }
}

/** Errors that mean "this pair can't be handled", not "the CLI is broken". */
const UNWRITABLE_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

/**
 * Describe an error that should skip one pair rather than abort the run.
 *
 * A build directory can hold a `.wasm` that isn't one (a saved error page) or
 * a map that isn't JSON. The JS path skips such files with a warning, so the
 * wasm path does too instead of failing after the JS files were rewritten.
 */
function skipReason(error: unknown): string | undefined {
  if (error instanceof WasmParseError) {
    return `not a valid wasm module: ${error.message}`;
  }
  if (error instanceof SyntaxError) {
    return `sourcemap is not valid JSON: ${error.message}`;
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && UNWRITABLE_CODES.has(code)) {
    return `cannot write files (${code})`;
  }
}

/** Warn about a pair and report it as untouched. */
function skip(pair: WasmPair, reason: string): WasmSyncResult {
  log.warn(`Skipping ${pair.wasmPath}: ${reason}`);
  return { ...pair, mapWritten: false, moduleStamped: false, skipped: reason };
}

async function reconcilePair(
  pair: WasmPair,
  options: WasmSyncOptions,
): Promise<WasmSyncResult> {
  const { wasmPath, mapPath } = pair;

  // One read serves both the lookup and the stamp. Reading the id first also
  // spares an already-stamped module the full re-encode `stampBuildId` does.
  const bytes = await readFile(wasmPath);
  const sections = parseSections(bytes);
  const existing = buildIdFromSections(sections);
  if (!existing && sections.some((s) => s.name === BUILD_ID_SECTION)) {
    // Stamping would append a second `build_id`, and readers disagree on
    // which one wins (symbolic takes the last, `@sentry/wasm` the first).
    return skip(pair, "its build_id section is malformed");
  }
  // Fail on a broken map before stamping, so a skipped pair wrote nothing.
  await readSourcemapFile(mapPath);
  const buildId = await ensureBuildIdOnDisk(wasmPath, bytes, existing, options);
  // Reported the same way in a dry run, as `injected` is for JS: the flags
  // say what a real run does, so a preview counts the files it would touch.
  const moduleStamped = !existing;

  const debugId = buildId
    ? debugIdFromBuildId(formatBuildId(buildId))
    : undefined;
  if (!debugId) {
    if (buildId) {
      log.warn(
        `${wasmPath} has a ${buildId.length}-byte build_id, too short for a debug ID, so its sourcemap gets none`,
      );
    }
    // Otherwise a dry run left the module unstamped; a real run would write
    // the minted id onto the map.
    return { wasmPath, mapPath, mapWritten: moduleStamped, moduleStamped };
  }

  const stamp = await setSourcemapDebugId(mapPath, debugId, {
    dryRun: options.dryRun,
  });
  if (stamp.replaced) {
    log.debug(
      `${mapPath} carried debug ID ${stamp.replaced}; replaced with the module's build_id ${debugId}`,
    );
  }

  return {
    wasmPath,
    mapPath,
    debugId,
    mapWritten: stamp.changed,
    moduleStamped,
  };
}

/**
 * Reconcile every discovered pair, in order.
 *
 * Sequential on purpose: each pair is two small file operations, and a
 * bounded-concurrency pool would buy nothing on the handful of modules a wasm
 * build emits.
 */
export async function syncWasmPairs(
  pairs: WasmPair[],
  options: WasmSyncOptions = {},
): Promise<WasmSyncResult[]> {
  const results: WasmSyncResult[] = [];
  for (const pair of pairs) {
    results.push(await syncWasmSourcemap(pair, options));
  }
  return results;
}

/**
 * Find `<stem>.wasm` + `<stem>.wasm.map` pairs in a build directory.
 *
 * Pairing is by filename convention only — the wasm `sourceMappingURL` custom
 * section is not consulted. Modules with no map beside them are not pairs and
 * are dropped silently; `buildEmptyDiscoveryError` explains the whole-directory
 * case.
 *
 * `*.debug.wasm` files are skipped: those are DWARF companions written by
 * `debug-files wasm-upload`, uploaded through the debug-file pipeline instead.
 *
 * @param dir - Directory to scan
 * @param options - Ignore matcher and glob filter, as for JS discovery
 * @returns One entry per module that has a companion map
 */
export async function discoverWasmPairs(
  dir: string,
  options: WasmDiscoveryOptions = {},
): Promise<WasmPair[]> {
  const absDir = resolvePath(dir);
  const pairs: WasmPair[] = [];
  for await (const wasmPath of walkWasmModules(absDir, options)) {
    const mapPath = `${wasmPath}.map`;
    // A JS pair is kept when either file matches the glob; so is a wasm pair.
    const included =
      !options.include ||
      options.include(relativePosix(absDir, wasmPath)) ||
      options.include(relativePosix(absDir, mapPath));
    if (included && (await hasCompanionMap(mapPath))) {
      pairs.push({ wasmPath, mapPath });
    }
  }
  return pairs;
}

/**
 * Extend a JS discovery diagnostic with wasm counts.
 *
 * Only called on the zero-pairs error path, so a second walk costs nothing
 * that matters. `.wasm.map` files are moved out of the JS `mapFiles` tally —
 * the JS walk counts every `.map` — so the JS branches of
 * `buildEmptyDiscoveryError` keep describing JS alone. Maps are counted
 * independently of modules, so a map left behind by a missing module is still
 * recognised as wasm.
 *
 * Narrowed by the glob target only, exactly as `diagnoseEmptyDiscovery` is:
 * the `.wasm.map` count is subtracted from the JS tally, so both walks must
 * see the same files.
 *
 * @param dir - Directory to scan
 * @param js - The diagnostic from `diagnoseEmptyDiscovery`
 * @param options - The glob filter the JS diagnostic used
 * @returns The diagnostic with wasm counts filled in
 */
export async function addWasmDiscoveryCounts(
  dir: string,
  js: DiscoveryDiagnostic,
  options: Pick<WasmDiscoveryOptions, "include"> = {},
): Promise<DiscoveryDiagnostic> {
  const absDir = resolvePath(dir);
  let wasmFiles = 0;
  let wasmMaps = 0;
  for await (const path of walkWasmModules(
    absDir,
    options,
    WASM_DIAGNOSTIC_EXTENSIONS,
  )) {
    const rel = relativePosix(absDir, path);
    const isMap = path.endsWith(".map");
    if (
      options.include &&
      !options.include(rel) &&
      !(isMap && options.include(rel.slice(0, -".map".length)))
    ) {
      continue;
    }
    // The widened extension set also yields JS `.map` files; those stay in the
    // JS tally.
    if (path.endsWith(".wasm.map")) {
      wasmMaps += 1;
    } else if (path.endsWith(".wasm")) {
      wasmFiles += 1;
    }
  }
  return {
    jsFiles: js.jsFiles,
    mapFiles: Math.max(js.mapFiles - wasmMaps, 0),
    wasmFiles,
    wasmMaps,
  };
}

/**
 * Yield the deployable `.wasm` modules under `absDir`.
 *
 * Uses the same traversal settings as JS discovery — build outputs are usually
 * gitignored, `dist`/`build` must not be pruned, and a wasm module easily
 * exceeds any size cap.
 *
 * @param extensions - Widened only by the diagnostic walk, which also needs
 * `.map` files; callers must then filter the extra extensions themselves.
 */
async function* walkWasmModules(
  absDir: string,
  { ignoreMatcher, include }: WasmDiscoveryOptions,
  extensions: ReadonlySet<string> = WASM_EXTENSIONS,
): AsyncGenerator<string> {
  for await (const entry of walkFiles({
    cwd: absDir,
    extensions,
    alwaysSkipDirs: SOURCEMAP_SKIP_DIRS,
    // A glob target can name hidden directories (`.next/static/**`).
    hidden: include !== undefined,
    respectGitignore: false,
    maxFileSize: Number.POSITIVE_INFINITY,
  })) {
    const wasmPath = entry.absolutePath;
    if (isDebugCompanionPath(wasmPath)) {
      continue;
    }
    if (ignoreMatcher?.ignores(relativePosix(absDir, wasmPath))) {
      continue;
    }
    yield wasmPath;
  }
}

/**
 * Whether a module's companion sourcemap exists.
 *
 * An absent map is the common case, not a failure: a module without one is
 * simply not a pair, and the whole-directory case is reported by
 * `buildEmptyDiscoveryError`.
 */
async function hasCompanionMap(mapPath: string): Promise<boolean> {
  try {
    return (await stat(mapPath)).isFile();
  } catch (error) {
    log.debug(`no companion sourcemap at ${mapPath}`, error);
    return false;
  }
}
