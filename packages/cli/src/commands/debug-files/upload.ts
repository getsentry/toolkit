/**
 * sentry debug-files upload <path>...
 *
 * Scan files and directories for native debug information files (Mach-O/dSYM,
 * ELF, PE/PDB, Portable PDB, WASM, Breakpad, source bundles), filter them, and
 * upload them to Sentry via the DIF chunk-upload protocol.
 *
 * Org/project are resolved via the standard cascade (DSN auto-detection, env
 * vars, config defaults), so `--no-upload` (dry-run) needs no credentials.
 *
 * Honors the server-advertised `max_file_size` (oversized files are skipped)
 * and `max_wait` (clamps the processing wait). `.zip` archives are scanned in
 * place (disable with `--no-zips`); `--derived-data` additionally scans Xcode's
 * DerivedData folder on macOS. Managed PE assemblies that embed a Portable PDB
 * have it extracted and uploaded automatically as a separate DIF, and
 * `--il2cpp-mapping` uploads Unity IL2CPP line mappings. BCSymbolMap
 * resolution (legacy `--symbol-maps`) is intentionally not supported: it only
 * applies to Apple Bitcode, which Apple has deprecated and the App Store no
 * longer accepts. Projects that still need it can use the legacy Rust
 * `sentry-cli`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SentryContext } from "../../context.js";
import {
  type ChunkServerOptions,
  DEFAULT_MAX_DIF_SIZE,
  getChunkUploadOptions,
} from "../../lib/api/chunk-upload.js";
import {
  DEBUG_FILES_MAX_WAIT_MS,
  type DebugFileUpload,
  type DebugFileUploadResult,
  uploadDebugFiles,
} from "../../lib/api/debug-files.js";
import { buildCommand } from "../../lib/command.js";
import {
  createIl2cppLineMapping,
  createSourceBundle,
} from "../../lib/dif/index.js";
import {
  buildDifFilters,
  debugIdMatches,
  type PreparedDif,
  prepareDifs,
  scanPaths,
} from "../../lib/dif/scan.js";
import { ContextError, ValidationError } from "../../lib/errors.js";
import {
  colorTag,
  mdKvTable,
  renderMarkdown,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { resolveOrgAndProject } from "../../lib/resolve-target.js";

const log = logger.withTag("debug-files.upload");

const USAGE_HINT = "sentry debug-files upload <path>...";

/** Relative path to Xcode's DerivedData folder under the user's home dir. */
const DERIVED_DATA_SUBPATH = "Library/Developer/Xcode/DerivedData";

/**
 * Resolve the effective scan paths, optionally appending Xcode's DerivedData
 * folder when `--derived-data` is set.
 *
 * DerivedData only exists on macOS; on other platforms the flag is a no-op
 * (with a warning). The folder is appended only when it actually exists, so the
 * stricter `scanPaths` existence check (which throws on a missing explicit
 * path) is never tripped by an absent DerivedData directory.
 *
 * @param paths - Positional paths supplied on the command line.
 * @param derivedData - Whether `--derived-data` was passed.
 * @returns The effective list of paths to scan.
 */
function collectScanPaths(paths: string[], derivedData: boolean): string[] {
  if (!derivedData) {
    return paths;
  }
  if (process.platform !== "darwin") {
    log.warn("--derived-data is only supported on macOS; ignoring it.");
    return paths;
  }
  const derivedDataPath = join(homedir(), DERIVED_DATA_SUBPATH);
  if (!existsSync(derivedDataPath)) {
    log.warn(
      `Xcode DerivedData folder not found at ${derivedDataPath}; ignoring --derived-data.`
    );
    return paths;
  }
  return [...paths, derivedDataPath];
}

// ── Types ───────────────────────────────────────────────────────────

/** Per-file entry in the command result. */
type UploadedFileSummary = {
  /** Name stamped on the DIF. */
  name: string;
  /** Advisory debug id, if known. */
  debugId?: string;
  /** Assembly state after upload (omitted for `--no-upload`). */
  state?: DebugFileUploadResult["state"];
  /** Server detail/error, if any. */
  detail?: string | null;
};

/** Structured result for the debug-files upload command. */
type DebugFilesUploadResult = {
  /** Organization slug. Omitted when `--no-upload` short-circuits. */
  org?: string;
  /** Project slug. Omitted when `--no-upload` short-circuits. */
  project?: string;
  /** Whether files were actually uploaded (false for `--no-upload`). */
  uploaded: boolean;
  /** Per-file results. */
  files: UploadedFileSummary[];
  /** Number of files uploaded (0 for `--no-upload`). */
  filesUploaded: number;
};

/** Flags accepted by the upload command. */
type UploadFlags = {
  type?: string[];
  id?: string[];
  "require-all"?: boolean;
  "no-debug"?: boolean;
  "no-unwind"?: boolean;
  "no-sources"?: boolean;
  "include-sources"?: boolean;
  "il2cpp-mapping"?: boolean;
  "derived-data"?: boolean;
  "no-zips"?: boolean;
  "no-upload"?: boolean;
  wait?: boolean;
  "wait-for"?: number;
};

// ── Formatter ───────────────────────────────────────────────────────

/** Human-readable label for an empty-state cell. */
function noneCell(): string {
  return colorTag("muted", "none");
}

/** Format human-readable output for the upload result. */
function formatUploadResult(data: DebugFilesUploadResult): string {
  const rows: [string, string][] = [];
  if (data.org) {
    rows.push(["Organization", data.org]);
  }
  if (data.project) {
    rows.push(["Project", data.project]);
  }
  rows.push([
    data.uploaded ? "Files uploaded" : "Files found",
    String(data.files.length),
  ]);
  for (const file of data.files) {
    const id = file.debugId ?? noneCell();
    const suffix = file.state ? `  [${file.state}]` : "";
    rows.push(["DIF", `${id}  ${file.name}${suffix}`]);
  }
  return renderMarkdown(mdKvTable(rows));
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a stable dedupe key from a file's debug id and content hash. */
function difKey(dif: DebugFileUpload): string {
  const hash = createHash("sha1").update(dif.content).digest("hex");
  return `${dif.debugId ?? ""}:${hash}`;
}

/**
 * Read a source file from disk for source-bundle/IL2CPP resolution, returning
 * `null` (and logging at debug level) when it is not available locally.
 */
function readSourceFile(sourcePath: string): Uint8Array | null {
  try {
    return readFileSync(sourcePath);
  } catch (err) {
    log.debug(`Source file not available, skipping: ${sourcePath}`, err);
    return null;
  }
}

/**
 * Compute a Unity IL2CPP line mapping for a prepared file and, when non-empty,
 * append it as a separate `il2cpp` DIF carrying the file's debug id.
 *
 * The generated C++ source files the object references are read from disk;
 * files not present locally are skipped. Failures (or a file with no IL2CPP
 * data) are swallowed (logged at debug level) so they never abort the upload.
 */
function appendIl2cppMapping(difs: DebugFileUpload[], file: PreparedDif): void {
  let result: ReturnType<typeof createIl2cppLineMapping>;
  try {
    result = createIl2cppLineMapping(
      new Uint8Array(file.content),
      readSourceFile,
      file.debugId
    );
  } catch (err) {
    log.debug(`Could not compute IL2CPP line mapping for ${file.path}`, err);
    return;
  }
  if (!result) {
    return;
  }
  difs.push({
    name: `${basename(file.path)}.il2cpp`,
    // Use the mapped object's own debug id so the DIF's id always matches its
    // contents (createIl2cppLineMapping maps the object with file.debugId).
    debugId: result.debugId,
    content: Buffer.from(result.mapping),
  });
}

/**
 * Convert prepared files into the DIF upload list.
 *
 * For each prepared file this queues the main DIF, then optionally a Unity
 * IL2CPP line-mapping DIF (`--il2cpp-mapping`) and a per-file source bundle
 * (`--include-sources`). Combining both also bundles the C# sources referenced
 * by IL2CPP `source_info` markers (`collectIl2cppSources`).
 *
 * Embedded Portable PDBs (extracted from managed PE assemblies during scanning)
 * arrive here as ordinary prepared DIFs, so no special handling is needed.
 *
 * Source files are read synchronously from the paths recorded in each object's
 * debug info; files not present locally are skipped. A bundle is only added
 * when it contains at least one source file.
 */
function buildDifList(
  prepared: PreparedDif[],
  options: { includeSources: boolean; il2cppMapping: boolean }
): DebugFileUpload[] {
  const { includeSources, il2cppMapping } = options;
  const difs: DebugFileUpload[] = [];
  for (const file of prepared) {
    difs.push({
      name: basename(file.path),
      debugId: file.debugId,
      content: file.content,
    });

    if (il2cppMapping) {
      appendIl2cppMapping(difs, file);
    }

    if (!includeSources) {
      continue;
    }

    let result: ReturnType<typeof createSourceBundle>;
    try {
      result = createSourceBundle(
        new Uint8Array(file.content),
        basename(file.path),
        readSourceFile,
        { collectIl2cppSources: il2cppMapping }
      );
    } catch (err) {
      log.debug(`Could not build source bundle for ${file.path}`, err);
      continue;
    }

    if (result.bundle && result.fileCount > 0) {
      // Stamp the bundle with the filter-passing primary object's debug id so
      // it matches the main DIF's advisory id, even when filters dropped the
      // slice `createSourceBundle` would otherwise have picked.
      const bundleDebugId = file.debugId ?? result.debugId ?? undefined;
      difs.push({
        name: `${bundleDebugId ?? basename(file.path)}.src.zip`,
        debugId: bundleDebugId,
        content: Buffer.from(result.bundle),
      });
    }
  }
  return difs;
}

/** Deduplicate DIFs by debug id + content hash, keeping the first occurrence. */
function dedupeDifs(difs: DebugFileUpload[]): DebugFileUpload[] {
  const seen = new Set<string>();
  const unique: DebugFileUpload[] = [];
  for (const dif of difs) {
    const key = difKey(dif);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(dif);
  }
  return unique;
}

/**
 * Determine which explicitly requested `--id` values were not found among the
 * uploaded files. Returns an empty array when `--id` was not used.
 */
function missingRequestedIds(
  requestedIds: string[] | undefined,
  prepared: PreparedDif[]
): string[] {
  if (!requestedIds || requestedIds.length === 0) {
    return [];
  }
  const foundIds = prepared.flatMap((p) => p.objects.map((o) => o.debugId));
  return requestedIds.filter(
    (requested) => !foundIds.some((found) => debugIdMatches(requested, found))
  );
}

/**
 * Resolve the wait mode and deadline from `--wait` / `--wait-for`.
 *
 * @throws {ValidationError} If both flags are set, or `--wait-for` is invalid.
 */
function resolveWaitMode(flags: UploadFlags): {
  wait: boolean;
  maxWaitMs: number;
} {
  const waitFor = flags["wait-for"];
  if (flags.wait && waitFor !== undefined) {
    throw new ValidationError(
      "--wait and --wait-for cannot be combined",
      "wait"
    );
  }
  if (waitFor !== undefined) {
    if (!Number.isFinite(waitFor) || waitFor <= 0) {
      throw new ValidationError(
        "--wait-for must be a positive number of seconds",
        "wait-for"
      );
    }
    return { wait: true, maxWaitMs: Math.round(waitFor * 1000) };
  }
  return { wait: Boolean(flags.wait), maxWaitMs: DEBUG_FILES_MAX_WAIT_MS };
}

// ── Command ─────────────────────────────────────────────────────────

/**
 * Yield a no-upload (dry-run) result and return the appropriate hint.
 * Handles --require-all exit-code logic.
 */
function* doDryRun(
  setExitCode: (code: number) => void,
  params: {
    difs: DebugFileUpload[];
    missingIds: string[];
    requireAll: boolean;
    oversizedCount: number;
  }
) {
  const { difs, missingIds, requireAll, oversizedCount } = params;
  yield new CommandOutput<DebugFilesUploadResult>({
    uploaded: false,
    files: difs.map((d) => ({ name: d.name, debugId: d.debugId })),
    filesUploaded: 0,
  });
  if (missingIds.length > 0 && requireAll) {
    setExitCode(1);
    return { hint: `Missing requested debug id(s): ${missingIds.join(", ")}` };
  }
  if (difs.length > 0) {
    return {
      hint: `Would upload ${difs.length} debug file(s). Remove --no-upload to upload.`,
    };
  }
  // Distinguish "nothing matched" from "files were skipped for size" so a
  // dry-run does not misleadingly report an empty scan. The count reflects
  // size-skipped files of a requested type; it does not claim that was the
  // only reason nothing would upload.
  return {
    hint:
      oversizedCount > 0
        ? `${oversizedCount} file(s) would be skipped for exceeding the maximum file size.`
        : `No debug information files found. Try: ${USAGE_HINT}`,
  };
}

/**
 * Report that nothing was found to upload (no auth needed).
 * Honors `--require-all`: exit 1 only when requested ids are missing.
 */
function* doNothingToUpload(
  setExitCode: (code: number) => void,
  params: {
    missingIds: string[];
    requireAll: boolean;
    oversizedCount: number;
    maxFileSize: number;
  }
) {
  const { missingIds, requireAll, oversizedCount, maxFileSize } = params;
  yield new CommandOutput<DebugFilesUploadResult>({
    uploaded: false,
    files: [],
    filesUploaded: 0,
  });
  // --require-all takes precedence: a requested id that wasn't found is the
  // most actionable failure, regardless of why the queue ended up empty.
  if (missingIds.length > 0 && requireAll) {
    setExitCode(1);
    return { hint: `Missing requested debug id(s): ${missingIds.join(", ")}` };
  }
  // Files of a requested type were found but skipped for size. Fail non-zero
  // with an accurate count (this does not claim it was the *only* reason the
  // queue is empty — other candidates may have failed id/feature filters).
  if (oversizedCount > 0) {
    setExitCode(1);
    return {
      hint: `No debug files were uploaded: ${oversizedCount} file(s) exceeded the maximum file size (${maxFileSize} bytes).`,
    };
  }
  log.warn("No debug information files found.");
  return { hint: `No debug information files found. Try: ${USAGE_HINT}` };
}

/**
 * Perform the upload, yield the result, and return a hint. Non-terminal states
 * (error, not_found) set the exit code and return a descriptive hint. Files
 * skipped for exceeding the maximum file size — at scan time (`oversizedCount`)
 * or at upload time (returned as `error` results by `uploadDebugFiles`) — also
 * set a non-zero exit, so a partial size-drop is never reported as a clean
 * success (consistent with the all-dropped path in `doNothingToUpload`).
 * Also honors `--require-all` against the requested `--id` values.
 */
async function* doUpload(
  setExitCode: (code: number) => void,
  params: {
    org: string;
    project: string;
    difs: DebugFileUpload[];
    wait: boolean;
    maxWaitMs: number;
    missingRequestedIds: string[];
    requireAll: boolean;
    oversizedCount: number;
    maxFileSize: number;
    serverOptions?: ChunkServerOptions;
  }
) {
  const results = await uploadDebugFiles(params);

  // Files the server (or the local size gate) rejected come back as
  // error/not_found results; they must not be counted as uploaded.
  const failures = results.filter(
    (r) => r.state === "error" || r.state === "not_found"
  );

  yield new CommandOutput<DebugFilesUploadResult>({
    org: params.org,
    project: params.project,
    uploaded: true,
    files: results.map((r) => ({
      name: r.name,
      debugId: r.debugId,
      state: r.state,
      detail: r.detail,
    })),
    filesUploaded: results.length - failures.length,
  });

  // Scan-time oversized files were dropped before the queue was built, so they
  // never appear in `results`. Note them on any failure hint and treat them as
  // a failure in their own right below.
  const scanOversize =
    params.oversizedCount > 0
      ? ` ${params.oversizedCount} file(s) were skipped for exceeding the maximum file size (${params.maxFileSize} bytes).`
      : "";

  // Appended to whichever hint returns first so `--require-all` feedback is
  // never lost behind an upload failure or a size-drop (all already exit 1).
  const requireAllNote =
    params.requireAll && params.missingRequestedIds.length > 0
      ? ` Missing requested debug id(s): ${params.missingRequestedIds.join(", ")}.`
      : "";

  if (failures.length > 0) {
    setExitCode(1);
    const details = failures
      .map(
        (r) =>
          `${r.debugId ?? r.name}: ${r.state}${r.detail ? ` (${r.detail})` : ""}`
      )
      .join("; ");
    return {
      hint: `${failures.length === 1 ? "1 file" : `${failures.length} files`} had failures: ${details}.${scanOversize}${requireAllNote}`,
    };
  }

  if (params.oversizedCount > 0) {
    setExitCode(1);
    return {
      hint: `Uploaded ${results.length} debug file(s) to ${params.org}/${params.project}, but ${params.oversizedCount} file(s) were skipped for exceeding the maximum file size (${params.maxFileSize} bytes).${requireAllNote}`,
    };
  }

  if (params.missingRequestedIds.length > 0 && params.requireAll) {
    setExitCode(1);
    return {
      hint: `Missing requested debug id(s): ${params.missingRequestedIds.join(", ")}`,
    };
  }

  return {
    hint: `Uploaded ${results.length} debug file(s) to ${params.org}/${params.project}`,
  };
}

export const uploadCommand = buildCommand({
  // Auth is not required for --no-upload (dry-run). The upload path calls
  // resolveOrgAndProject which triggers auth resolution.
  auth: false,
  docs: {
    brief: "Upload debug information files to Sentry",
    fullDescription:
      "Scan files and directories for native debug information files and " +
      "upload them to Sentry using the chunk-upload protocol. Supports " +
      "Mach-O/dSYM, ELF, PE/PDB, Portable PDB, WebAssembly, Breakpad, and " +
      "source bundles. Directories are scanned recursively.\n\n" +
      "Org/project are auto-detected from DSN, env vars, or config defaults.\n\n" +
      "Filters:\n" +
      "  --type     Only upload files of the given type (repeatable):\n" +
      "             dsym, elf, pe, pdb, portablepdb, wasm, breakpad,\n" +
      "             sourcebundle, jvm\n" +
      "  --id       Only upload the object with the given debug id (repeatable)\n" +
      "  --no-debug / --no-unwind / --no-sources   Drop files whose only\n" +
      "             useful feature is the named one\n" +
      "  --derived-data   Also scan Xcode's DerivedData folder (macOS only)\n" +
      "  --no-zips        Do not scan inside .zip archives\n\n" +
      ".zip archives are scanned in place by default; nested archives are not " +
      "recursed.\n\n" +
      "Managed PE assemblies (.NET) that embed a Portable PDB have it extracted " +
      "and uploaded automatically as a separate <name>.pdb debug file.\n\n" +
      "With --il2cpp-mapping, Unity IL2CPP C++->C# line mappings are computed " +
      "from each file's referenced generated C++ sources and uploaded as " +
      "separate il2cpp debug files; combine with --include-sources to also " +
      "bundle the referenced C# source files.\n\n" +
      "Usage:\n" +
      "  sentry debug-files upload ./build\n" +
      "  sentry debug-files upload ./symbols.zip\n" +
      "  sentry debug-files upload ./libexample.so --include-sources\n" +
      "  sentry debug-files upload ./dsyms --type dsym --wait\n" +
      "  sentry debug-files upload ./build --il2cpp-mapping --include-sources\n" +
      "  sentry debug-files upload --derived-data --no-upload\n" +
      "  sentry debug-files upload ./build --no-zips --no-upload\n\n" +
      "BCSymbolMap resolution (legacy --symbol-maps) is not supported: it " +
      "only applies to Apple Bitcode, which Apple has deprecated. Use the " +
      "legacy Rust sentry-cli if you still need it.",
  },
  output: {
    human: formatUploadResult,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "Files or directories to scan for debug information files",
        parse: String,
        placeholder: "path",
      },
    },
    flags: {
      type: {
        kind: "parsed",
        parse: String,
        brief:
          "Only upload files of this type (repeatable): dsym, elf, pe, pdb, " +
          "portablepdb, wasm, breakpad, sourcebundle, jvm",
        optional: true,
        variadic: true,
      },
      id: {
        kind: "parsed",
        parse: String,
        brief: "Only upload the object with this debug id (repeatable)",
        optional: true,
        variadic: true,
      },
      "require-all": {
        kind: "boolean",
        brief: "Fail if any --id value was not found among scanned files",
        optional: true,
        default: false,
      },
      "no-debug": {
        kind: "boolean",
        brief: "Do not upload files whose only feature is debug/symbol info",
        optional: true,
        default: false,
      },
      "no-unwind": {
        kind: "boolean",
        brief: "Do not upload files whose only feature is unwind info",
        optional: true,
        default: false,
      },
      "no-sources": {
        kind: "boolean",
        brief: "Do not upload files whose only feature is source info",
        optional: true,
        default: false,
      },
      "include-sources": {
        kind: "boolean",
        brief: "Build and upload a source bundle for each file with debug info",
        optional: true,
        default: false,
      },
      "il2cpp-mapping": {
        kind: "boolean",
        brief:
          "Compute and upload Unity IL2CPP line mappings for each scanned file",
        optional: true,
        default: false,
      },
      "derived-data": {
        kind: "boolean",
        brief: "Also scan Xcode's DerivedData folder (macOS only)",
        optional: true,
        default: false,
      },
      "no-zips": {
        kind: "boolean",
        brief: "Do not scan inside .zip archives",
        optional: true,
        default: false,
      },
      "no-upload": {
        kind: "boolean",
        brief: "Scan and print what would be uploaded without uploading",
        optional: true,
        default: false,
      },
      wait: {
        kind: "boolean",
        brief: "Wait for server-side processing and report any errors",
        optional: true,
        default: false,
      },
      "wait-for": {
        kind: "parsed",
        parse: Number,
        brief: "Wait up to this many seconds for server-side processing",
        optional: true,
      },
    },
    aliases: {
      t: "type",
    },
  },
  async *func(this: SentryContext, flags: UploadFlags, ...paths: string[]) {
    const scanTargets = collectScanPaths(paths, Boolean(flags["derived-data"]));
    if (scanTargets.length === 0) {
      throw new ContextError("Debug file path(s)", USAGE_HINT, []);
    }
    const { wait, maxWaitMs } = resolveWaitMode(flags);
    const requireAll = Boolean(flags["require-all"]);
    const setExitCode = (c: number) => {
      this.process.exitCode = c;
    };

    const filters = buildDifFilters({
      types: flags.type,
      ids: flags.id,
      noDebug: flags["no-debug"],
      noUnwind: flags["no-unwind"],
      noSources: flags["no-sources"],
    });

    // For a real upload, resolve org/project and fetch the server's upload
    // options up front. The server's advertised `maxFileSize` then gates the
    // scan, so a file the server would reject is never read into memory.
    // `--no-upload` stays auth-free and uses the generous default cap.
    let resolved: Awaited<ReturnType<typeof resolveOrgAndProject>> = null;
    let serverOptions: ChunkServerOptions | undefined;
    let maxFileSize = DEFAULT_MAX_DIF_SIZE;
    if (!flags["no-upload"]) {
      resolved = await resolveOrgAndProject({
        cwd: this.cwd,
        usageHint: USAGE_HINT,
      });
      if (!resolved) {
        throw new ContextError("Organization and project", USAGE_HINT);
      }
      serverOptions = await getChunkUploadOptions(resolved.org);
      if (serverOptions.maxFileSize && serverOptions.maxFileSize > 0) {
        maxFileSize = serverOptions.maxFileSize;
      }
    }

    const files = await scanPaths(scanTargets);
    const { prepared, oversizedCount } = await prepareDifs(files, filters, {
      maxFileSize,
      scanZips: !flags["no-zips"],
    });
    const difs = dedupeDifs(
      buildDifList(prepared, {
        includeSources: Boolean(flags["include-sources"]),
        il2cppMapping: Boolean(flags["il2cpp-mapping"]),
      })
    );
    const missingIds = missingRequestedIds(flags.id, prepared);

    // Dry-run is purely informational: report what would upload (and surface
    // size skips) without erroring.
    if (flags["no-upload"]) {
      return yield* doDryRun(setExitCode, {
        difs,
        missingIds,
        requireAll,
        oversizedCount,
      });
    }

    if (difs.length === 0) {
      return yield* doNothingToUpload(setExitCode, {
        missingIds,
        requireAll,
        oversizedCount,
        maxFileSize,
      });
    }

    // `resolved` is guaranteed set here: the non-dry-run branch above resolved
    // it or threw.
    if (!resolved) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }

    return yield* doUpload(setExitCode, {
      org: resolved.org,
      project: resolved.project,
      serverOptions,
      difs,
      wait,
      maxWaitMs,
      missingRequestedIds: missingIds,
      requireAll,
      oversizedCount,
      maxFileSize,
    });
  },
});
