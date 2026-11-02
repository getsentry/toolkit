/**
 * Run a script embedded in the standalone binary, with a V8 code cache on disk.
 *
 * The binary's SEA main script is a small bootstrap (`src/sea-main.ts`). The
 * CLI and the shell-completion engine are separate SEA assets, so a TAB press
 * compiles only the completion engine, not the whole CLI.
 *
 * Node's SEA code cache covers only the main script, so this module keeps its
 * own: the first run compiles a chunk from source and, on exit, writes the V8
 * code cache for every function that ran. Later runs read it back. Because the
 * cache is written by the binary that reads it, it works on every platform,
 * including the ones cross-compiled in CI, where fossilize can't build one.
 *
 * Imports only `node:` builtins: it runs before every command.
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { constants, Script } from "node:vm";

/** CommonJS scope a chunk runs in, the same one the SEA main script gets. */
export type ChunkScope = {
  exports: unknown;
  require: NodeJS.Require;
  module: NodeJS.Module;
  filename: string;
  dirname: string;
};

export type SeaChunk = {
  /** The chunk's CommonJS source, as esbuild emits it. */
  source: string;
  /**
   * Filename in stack traces. It matches the URL of the sourcemap uploaded
   * for the chunk, and the path the SEA main script reported before the split.
   */
  filename: string;
  /** Names the chunk's code cache files, such as `cli`. */
  name: string;
  /**
   * Hash of `source`, part of the code cache file name. V8 checks only the
   * length of the source a cache was made for, so without it a cache from
   * another build of the same length would run that build's code.
   */
  buildId: string;
};

/**
 * `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` lets the chunk's `import()`
 * calls use Node's default loader, as they did in the main script. Node marks
 * it experimental and warns once; the warning is noise for CLI users.
 */
const LOADER_WARNING = "USE_MAIN_CONTEXT_DEFAULT_LOADER";

/**
 * The CommonJS wrapper starts on its own line, and `lineOffset: -1` hides that
 * line, so line and column numbers in stack traces match the sourcemap.
 */
const WRAPPER_HEAD =
  "(function (exports, require, module, __filename, __dirname) {\n";
const WRAPPER_TAIL = "\n})";

/**
 * Code caches kept per chunk. More than one, so two installed versions used in
 * turn (a stable binary and a nightly) don't keep replacing each other's.
 */
const MAX_CACHED_BUILDS = 3;

let loaderWarningSuppressed = false;

function suppressLoaderWarning(): void {
  if (loaderWarningSuppressed) {
    return;
  }
  loaderWarningSuppressed = true;
  const originalEmit = process.emit.bind(process) as typeof process.emit;
  process.emit = ((event: string, ...args: unknown[]) => {
    const [warning] = args;
    if (
      event === "warning" &&
      warning instanceof Error &&
      warning.name === "ExperimentalWarning" &&
      warning.message.includes(LOADER_WARNING)
    ) {
      return false;
    }
    // @ts-expect-error: forwarding args to original emit
    return originalEmit(event, ...args);
  }) as typeof process.emit;
}

/**
 * Report a code cache failure under `SENTRY_LOG_LEVEL=debug`. The logger is
 * not loaded yet, and a cache failure only costs time, so it never fails the
 * command.
 */
export function reportCodeCacheError(message: string, error: unknown): void {
  const level = process.env.SENTRY_LOG_LEVEL;
  if (level === "debug" || level === "trace") {
    process.stderr.write(`[code-cache] ${message}: ${String(error)}\n`);
  }
}

function readCodeCache(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      reportCodeCacheError(`Could not read ${path}`, error);
    }
    return;
  }
}

/** Delete all but the {@link MAX_CACHED_BUILDS} newest caches of a chunk. */
function pruneCodeCaches(cacheDir: string, chunkName: string): void {
  const caches = readdirSync(cacheDir)
    .filter(
      (entry) => entry.startsWith(`${chunkName}-`) && entry.endsWith(".bin"),
    )
    .map((entry) => {
      const path = join(cacheDir, entry);
      return { path, mtime: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { path } of caches.slice(MAX_CACHED_BUILDS)) {
    rmSync(path, { force: true });
  }
}

/**
 * Write `data` to `cacheDir/fileName` and prune the chunk's old caches. The
 * rename is atomic, so a concurrent run never reads a partial file.
 */
function writeCodeCache(
  cacheDir: string,
  fileName: string,
  chunkName: string,
  data: Buffer,
): void {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const path = join(cacheDir, fileName);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, data, { mode: 0o600 });
    renameSync(temporary, path);
    pruneCodeCaches(cacheDir, chunkName);
  } catch (error) {
    reportCodeCacheError(
      `Could not write the code cache to ${cacheDir}`,
      error,
    );
  }
}

/** Runs `callback` once when the process exits. */
type OnExit = (callback: () => void) => void;

const onProcessExit: OnExit = (callback) => {
  process.once("exit", callback);
};

/**
 * Compile and run `chunk` in `scope`.
 *
 * `cacheDir` holds the code cache, one file per chunk and platform. When it
 * is `undefined`, the chunk compiles from source every time. Without an
 * accepted cache, `onExit` gets the callback that writes one.
 *
 * @returns Whether a code cache was read and accepted
 */
export function runSeaChunk(
  chunk: SeaChunk,
  scope: ChunkScope,
  cacheDir: string | undefined,
  onExit: OnExit = onProcessExit,
): boolean {
  // A shared config directory can serve binaries for several platforms (an
  // x64 binary under Rosetta next to an arm64 one), and V8 rejects a cache
  // made on another CPU architecture.
  const fileName = `${chunk.name}-${chunk.buildId}-${process.platform}-${process.arch}.bin`;
  const cachedData =
    cacheDir === undefined
      ? undefined
      : readCodeCache(join(cacheDir, fileName));

  suppressLoaderWarning();
  const script = new Script(`${WRAPPER_HEAD}${chunk.source}${WRAPPER_TAIL}`, {
    filename: chunk.filename,
    lineOffset: -1,
    cachedData,
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  });
  const cacheAccepted = cachedData !== undefined && !script.cachedDataRejected;

  if (cacheDir !== undefined && !cacheAccepted) {
    // On exit the cache also holds the functions compiled while the command
    // ran, not only the top level.
    onExit(() => {
      writeCodeCache(cacheDir, fileName, chunk.name, script.createCachedData());
    });
  }

  const run = script.runInThisContext() as (
    exports: unknown,
    require: NodeJS.Require,
    module: NodeJS.Module,
    filename: string,
    dirname: string,
  ) => void;
  run.call(
    scope.exports,
    scope.exports,
    scope.require,
    scope.module,
    scope.filename,
    scope.dirname,
  );
  return cacheAccepted;
}
