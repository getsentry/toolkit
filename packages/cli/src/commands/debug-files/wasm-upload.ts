/**
 * sentry debug-files wasm-upload <path>...
 *
 * Scan for WebAssembly modules, split the ones carrying inline DWARF into a
 * deployable module plus a `*.debug.wasm` companion, and upload the companions
 * to Sentry.
 *
 * This replaces the two-step `wasm-split` + `debug-files upload` workflow. The
 * split matches what Symbolicator's `wasm-split` produces, so companions from
 * either tool are interchangeable in Sentry.
 *
 * Modules that cannot be split are stamped with a `build_id` and reported with
 * a warning rather than failing the run, so scanning a build directory does not
 * stop at the first module without DWARF. Use `--require-dwarf` in CI to turn
 * that into an error.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { SentryContext } from "../../context.js";
import {
  type ChunkServerOptions,
  getChunkUploadOptions,
} from "../../lib/api/chunk-upload.js";
import {
  type DebugFileUpload,
  uploadDebugFiles,
} from "../../lib/api/debug-files.js";
import { buildCommand } from "../../lib/command.js";
import { createSourceBundle } from "../../lib/dif/index.js";
import { scanPaths } from "../../lib/dif/scan.js";
import { ContextError, ValidationError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { formatPrepareResult } from "../../lib/formatters/wasm-prepare.js";
import { logger } from "../../lib/logger.js";
import { resolveOrgAndProject } from "../../lib/resolve-target.js";
import { buildIgnoreMatcher, normalizePath } from "../../lib/scan/index.js";
import { debugIdFromBuildId, uuidToBytes } from "../../lib/wasm/build-id.js";
import {
  findReferencedCompanions,
  hasDwarfQuality,
  isDebugCompanionPath,
  isWasmPath,
  type PrepareAction,
  type PrepareCommandResult,
  type PrepareResult,
  prepareWasmFile,
  uploadPath,
} from "../../lib/wasm/prepare.js";
import { readSourceFile } from "./read-file.js";
import { resolveWaitMode, type WaitFlags } from "./wait.js";

const log = logger.withTag("debug-files.wasm-upload");

const USAGE_HINT = "sentry debug-files wasm-upload <path>...";

/** Flags accepted by the wasm-upload command. */
type PrepareFlags = WaitFlags & {
  "dry-run"?: boolean;
  "no-upload"?: boolean;
  "require-dwarf"?: boolean;
  "out-dir"?: string;
  "strip-names"?: boolean;
  "build-id"?: string;
  "include-sources"?: boolean;
  ignore?: string[];
  "ignore-file"?: string;
};

/**
 * Parse the explicit `--build-id` value into raw bytes.
 *
 * @throws {ValidationError} If the value is not a UUID.
 */
function resolveBuildId(value: string | undefined): Uint8Array | undefined {
  if (value === undefined) {
    return;
  }
  const bytes = uuidToBytes(value);
  if (!bytes) {
    throw new ValidationError(
      `--build-id must be a UUID, got '${value}'`,
      "build-id",
    );
  }
  return bytes;
}

/**
 * Whether a module fails the `--require-dwarf` gate.
 *
 * Only skipped modules can fail: a split or already-prepared module reached the
 * end state the flag is checking for.
 *
 * A skipped `external_debug_info` module is a dangling pointer by
 * construction — had its companion been found with a matching build id, it
 * would have been reported as already-prepared. The DWARF exists somewhere,
 * but nothing reachable was uploaded, so the build symbolicates no better than
 * one compiled without debug info and the gate has to catch it.
 */
export function lacksDwarf(result: PrepareResult): boolean {
  if (result.action !== "skipped") {
    return false;
  }
  return (
    result.quality === "external-debug-info" || !hasDwarfQuality(result.quality)
  );
}

/** Yield a result that uploaded nothing, then close with the given hint. */
function* reportWithoutUpload(params: {
  results: PrepareResult[];
  hint: string;
}) {
  yield new CommandOutput<PrepareCommandResult>({
    uploaded: false,
    modules: params.results,
    filesUploaded: 0,
  });
  return { hint: params.hint };
}

/** Upload the companions, yield the combined result, and pick a hint. */
async function* reportUpload(
  setExitCode: (code: number) => void,
  params: {
    org: string;
    project: string;
    difs: DebugFileUpload[];
    results: PrepareResult[];
    wait: boolean;
    maxWaitMs: number;
    serverOptions: ChunkServerOptions;
  },
) {
  const uploads = await uploadDebugFiles(params);
  const failures = uploads.filter(
    (r) => r.state === "error" || r.state === "not_found",
  );

  yield new CommandOutput<PrepareCommandResult>({
    org: params.org,
    project: params.project,
    uploaded: true,
    modules: params.results,
    filesUploaded: uploads.length - failures.length,
  });

  if (failures.length > 0) {
    setExitCode(1);
    const details = failures
      .map((r) => `${r.debugId ?? r.name}: ${r.state}`)
      .join("; ");
    return { hint: `${failures.length} debug file(s) failed: ${details}` };
  }

  return {
    hint: `Uploaded ${uploads.length} debug file(s) to ${params.org}/${params.project}`,
  };
}

const COMPANION_PRODUCING_ACTIONS = new Set<PrepareAction>([
  "split",
  "would-split",
  "already-prepared",
]);

/**
 * Whether a module has a companion, or would get one on a real run.
 *
 * Unlike {@link uploadPath} this counts `would-split`, so a dry run reports the
 * work it would do rather than the (always empty) set it would upload.
 */
function producesCompanion(result: PrepareResult): boolean {
  return COMPANION_PRODUCING_ACTIONS.has(result.action);
}

/**
 * Append a source bundle for a companion, when it references sources available
 * on this machine.
 *
 * The companion is where the DWARF lives, so it is the only artifact that can
 * name the source files to collect. Failures are logged and swallowed so a
 * missing source tree never aborts the upload.
 */
function appendSourceBundle(
  difs: DebugFileUpload[],
  companion: Uint8Array,
  name: string,
  debugId: string | undefined,
): void {
  let result: ReturnType<typeof createSourceBundle>;
  try {
    result = createSourceBundle(companion, name, readSourceFile);
  } catch (err) {
    log.debug(`Could not build source bundle for ${name}`, err);
    return;
  }
  if (!(result.bundle && result.fileCount > 0)) {
    return;
  }
  const bundleDebugId = debugId ?? result.debugId ?? undefined;
  difs.push({
    name: `${bundleDebugId ?? name}.src.zip`,
    debugId: bundleDebugId,
    content: Buffer.from(result.bundle),
  });
}

/** Read each companion from disk and turn it into an upload entry. */
async function collectCompanionDifs(
  results: PrepareResult[],
  includeSources: boolean,
): Promise<DebugFileUpload[]> {
  const difs: DebugFileUpload[] = [];
  for (const result of results) {
    const path = uploadPath(result);
    if (!path) {
      continue;
    }
    const content = await readFile(path);
    // The server re-parses the bytes and indexes every slice itself, so the id
    // is advisory; send it in the canonical dashed form or not at all.
    const debugId = result.buildId
      ? debugIdFromBuildId(result.buildId)
      : undefined;
    difs.push({ name: basename(path), debugId, content });

    if (includeSources) {
      appendSourceBundle(
        difs,
        new Uint8Array(content),
        basename(path),
        debugId,
      );
    }
  }
  return difs;
}

/**
 * Path of a scanned file relative to the scan root it came from.
 *
 * Ignore patterns are written against the tree the user pointed at — `--ignore
 * 'vendor/**'` for `prepare ./dist` means `./dist/vendor` — so they must be
 * tested against a root-relative path rather than one relative to the process
 * working directory. Separators are normalized to `/` because the `ignore`
 * package only understands POSIX paths.
 */
function pathRelativeToRoot(path: string, roots: string[]): string {
  const resolved = resolve(path);
  let deepestRoot = "";
  for (const root of roots) {
    const rootPath = resolve(root);
    const contains =
      resolved === rootPath || resolved.startsWith(`${rootPath}${sep}`);
    if (contains && rootPath.length > deepestRoot.length) {
      deepestRoot = rootPath;
    }
  }
  // A root naming the file itself leaves nothing relative to match on, so fall
  // back to the basename.
  const rel = deepestRoot ? relative(deepestRoot, resolved) : "";
  return normalizePath(rel === "" ? basename(resolved) : rel);
}

/**
 * Reject an explicitly named file that is not a WebAssembly module.
 *
 * A directory is scanned recursively and simply yields nothing, but naming a
 * non-`.wasm` file directly is a mistake worth reporting rather than silently
 * treating as an empty scan.
 *
 * @throws {ValidationError} If an explicit path is a file without a `.wasm`
 *   extension.
 */
async function assertWasmPaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && !isWasmPath(path)) {
      throw new ValidationError(
        `Expected a .wasm file or a directory, but got ${path}`,
        "path",
      );
    }
  }
}

/**
 * Reject `--build-id` for anything but one explicitly named module.
 *
 * The flag supplies a single id, and every module that needs stamping would
 * receive it. Sentry matches a stack frame to its debug file by build id, so
 * modules sharing one are indistinguishable and neither symbolicates
 * reliably. A directory can always hold more than one module, which is why it
 * is refused even when it currently holds exactly one.
 *
 * @throws {ValidationError} If several paths were given, or the single path is
 *   not a file.
 */
async function assertSingleModuleForBuildId(paths: string[]): Promise<void> {
  const [path, ...rest] = paths;
  // A path that does not exist is left to the scan, which names it in its own
  // error rather than blaming the flag.
  const info = path ? await stat(path).catch(() => null) : null;
  if (rest.length > 0 || info?.isDirectory()) {
    throw new ValidationError(
      "--build-id applies to one module: pass a single .wasm file, not a " +
        "directory or several paths",
      "build-id",
    );
  }
}

export const wasmUploadCommand = buildCommand({
  // Auth is only needed on the upload path; --dry-run and --no-upload skip it.
  auth: false,
  docs: {
    brief: "Split WebAssembly debug info and upload it to Sentry",
    fullDescription:
      "Scan files and directories for WebAssembly modules, split the ones " +
      "carrying inline DWARF, and upload the debug companions to Sentry.\n\n" +
      "For each module with DWARF this injects a build_id (if absent), writes " +
      "a <stem>.<build_id>.debug.wasm companion retaining the Code section " +
      "and DWARF, strips the .debug_* sections from the deployable module in " +
      "place, and points it at the companion via external_debug_info. The " +
      "deployable module keeps its original path, so your build artifact does " +
      "not move.\n\n" +
      "Modules without DWARF are stamped with a build_id and reported with a " +
      "warning instead of failing the run. Running the command twice is safe: " +
      "an already-prepared module is detected and left alone.\n\n" +
      "Org/project are auto-detected from DSN, env vars, or config defaults.\n\n" +
      "--require-dwarf is checked before anything is uploaded, so a build " +
      "missing debug info fails without pushing files first. A module whose " +
      "external_debug_info points at a companion that cannot be found fails " +
      "too: its debug info is unreachable.\n\n" +
      "--build-id names one module and is rejected for a directory or for " +
      "several paths. Every module that needs stamping would take the id, and " +
      "modules sharing one cannot be told apart when Sentry looks for their " +
      "debug files.\n\n" +
      "Usage:\n" +
      "  sentry debug-files wasm-upload ./dist\n" +
      "  sentry debug-files wasm-upload ./app.wasm --no-upload\n" +
      "  sentry debug-files wasm-upload ./app.wasm --build-id <UUID>\n" +
      "  sentry debug-files wasm-upload ./dist --dry-run\n" +
      "  sentry debug-files wasm-upload ./dist --require-dwarf\n" +
      "  sentry debug-files wasm-upload ./dist --out-dir ./symbols\n" +
      "  sentry debug-files wasm-upload ./dist --include-sources\n" +
      "  sentry debug-files wasm-upload ./dist --ignore 'vendor/**'",
  },
  output: {
    human: formatPrepareResult,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "WebAssembly files or directories to scan",
        parse: String,
        placeholder: "path",
      },
    },
    flags: {
      "dry-run": {
        kind: "boolean",
        brief: "Classify modules without writing or uploading anything",
        optional: true,
        default: false,
      },
      "no-upload": {
        kind: "boolean",
        brief: "Split modules but do not upload the companions",
        optional: true,
        default: false,
      },
      "require-dwarf": {
        kind: "boolean",
        brief: "Fail if any scanned module lacks DWARF debug info",
        optional: true,
        default: false,
      },
      "out-dir": {
        kind: "parsed",
        parse: String,
        brief:
          "Directory for *.debug.wasm companions (modules are stripped in place)",
        optional: true,
      },
      "strip-names": {
        kind: "boolean",
        brief:
          "Also drop the name section from split modules (companion keeps it)",
        optional: true,
        default: false,
      },
      "build-id": {
        kind: "parsed",
        parse: String,
        brief:
          "Use this UUID as the build id instead of a random one (one .wasm file only)",
        optional: true,
      },
      "include-sources": {
        kind: "boolean",
        brief: "Also upload a source bundle for each companion",
        optional: true,
        default: false,
      },
      ignore: {
        kind: "parsed",
        parse: String,
        brief: "Skip files and folders matching this glob (repeatable)",
        optional: true,
        variadic: true,
      },
      "ignore-file": {
        kind: "parsed",
        parse: String,
        brief: "Skip files and folders listed in this ignore file",
        optional: true,
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
  },
  async *func(this: SentryContext, flags: PrepareFlags, ...paths: string[]) {
    if (paths.length === 0) {
      throw new ContextError("WebAssembly path(s)", USAGE_HINT, []);
    }
    const { wait, maxWaitMs } = resolveWaitMode(flags);
    const buildId = resolveBuildId(flags["build-id"]);
    const dryRun = Boolean(flags["dry-run"]);
    const setExitCode = (code: number) => {
      this.process.exitCode = code;
    };

    await assertWasmPaths(paths);
    if (buildId) {
      await assertSingleModuleForBuildId(paths);
    }
    const ignoreMatcher = await buildIgnoreMatcher(
      flags.ignore,
      flags["ignore-file"],
    );

    // Companions are inputs to a previous run, never candidates themselves.
    const candidates = (await scanPaths(paths)).filter(
      (path) =>
        isWasmPath(path) &&
        !isDebugCompanionPath(path) &&
        !ignoreMatcher?.ignores(pathRelativeToRoot(path, paths)),
    );

    if (candidates.length === 0) {
      log.warn("No WebAssembly modules found.");
      return yield* reportWithoutUpload({
        results: [],
        hint: `No .wasm modules found. Try: ${USAGE_HINT}`,
      });
    }

    // A custom-named companion looks like a module with DWARF; splitting it
    // would strip the debug info its deployable points at.
    const companions = await findReferencedCompanions(candidates);
    const modules = candidates.filter((path) => {
      if (!companions.has(resolve(path))) {
        return true;
      }
      log.debug(`Skipping ${path}: referenced as a debug companion`);
      return false;
    });

    const results: PrepareResult[] = [];
    for (const path of modules) {
      results.push(
        await prepareWasmFile(path, {
          dryRun,
          outDir: flags["out-dir"],
          buildId,
          stripNames: flags["strip-names"],
        }),
      );
    }

    // The DWARF gate runs before anything is uploaded: a build missing debug
    // info should fail cleanly rather than push files and then go red.
    const missingDwarf = results.filter(lacksDwarf);
    if (flags["require-dwarf"] && missingDwarf.length > 0) {
      setExitCode(1);
      return yield* reportWithoutUpload({
        results,
        hint: `${missingDwarf.length} module(s) have no reachable DWARF debug info (--require-dwarf).`,
      });
    }

    const prepared = results.filter(producesCompanion).length;

    // A dry run reports what it found and stops before any upload.
    if (dryRun || flags["no-upload"]) {
      return yield* reportWithoutUpload({
        results,
        hint: dryRun
          ? `Would prepare ${prepared} module(s). Remove --dry-run to write them.`
          : `Prepared ${prepared} module(s). Remove --no-upload to upload the companions.`,
      });
    }

    const difs = await collectCompanionDifs(
      results,
      Boolean(flags["include-sources"]),
    );
    if (difs.length === 0) {
      return yield* reportWithoutUpload({
        results,
        hint: "No debug companions to upload.",
      });
    }

    const resolved = await resolveOrgAndProject({
      cwd: this.cwd,
      usageHint: USAGE_HINT,
    });
    if (!resolved) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }

    return yield* reportUpload(setExitCode, {
      org: resolved.org,
      project: resolved.project,
      difs,
      results,
      wait,
      maxWaitMs,
      serverOptions: await getChunkUploadOptions(resolved.org),
    });
  },
});
