/**
 * Load the CLI's code-split bundle, with a V8 code cache on disk.
 *
 * The npm package and the standalone binary ship the CLI as the same
 * CommonJS chunks (see `script/lib/split-bundle.ts`), which require each
 * other by file name. Their main script (`src/chunk-main.ts`) runs the entry
 * chunk through {@link createChunkLoader}, which resolves those requires
 * itself and reads each chunk from a file (npm) or a SEA asset (binary). A
 * command compiles only the chunks it loads.
 *
 * Each chunk keeps a code cache: the first run compiles it from source and,
 * on exit, writes the V8 code cache for every function that ran. Later runs
 * read it back. Node has no cache for these chunks: its SEA `useCodeCache`
 * compiles only the `main` script when it builds the binary, and SEA assets
 * are bytes that `sea.getAsset()` returns, which Node never compiles. Its
 * compile cache (`module.enableCompileCache()`) covers only the files its
 * module loader reads, not source run through `vm.Script`. So the loader
 * keeps its own. Because the program that reads a cache also writes it, it
 * works on every platform, including the binaries cross-compiled in CI,
 * where a build-time code cache would come from the wrong platform.
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
import { cachedDataVersionTag } from "node:v8";
import { constants, Script } from "node:vm";

/** The chunks of one build. */
export type ChunkBuild = {
  /**
   * Hash of every chunk, part of the code cache directory name. V8 checks
   * only the length of the source a cache was made for, so without it a
   * cache from another build would run that build's code.
   */
  readonly id: string;
  /** File names of the chunks, which they require each other by (`./<name>`). */
  readonly chunks: readonly string[];
};

/** Where the chunks of a build come from. */
export type ChunkSource = {
  /** The CommonJS source of chunk `name`, as esbuild emits it. */
  readonly read: (name: string) => string;
  /**
   * Filename of chunk `name` in stack traces. It matches the URL of the
   * sourcemap uploaded for the chunk.
   */
  readonly filename: (name: string) => string;
  /** The `__filename` and `__dirname` chunk `name` runs with. */
  readonly scope: (name: string) => { filename: string; dirname: string };
  /** Loads everything that is not a chunk, like `node:` builtins. */
  readonly require: NodeJS.Require;
};

/** Runs `callback` once when the process exits. */
export type OnExit = (callback: () => void) => void;

/**
 * `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER` lets the chunks' `import()`
 * calls use Node's default loader, as they would in a file Node loaded. Node
 * marks it experimental and warns once; the warning is noise for CLI users.
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
 * Builds whose code caches are kept. More than one, so two installed versions
 * used in turn (a stable binary and a nightly) don't keep replacing each
 * other's.
 */
const MAX_CACHED_BUILDS = 3;

/** This platform and architecture, which a code cache only works on. */
const PLATFORM = `${process.platform}-${process.arch}`;

/** A code cache directory of this platform: `<build id>-<platform>-<V8 tag>`. */
const PLATFORM_CACHE_DIR_RE = new RegExp(`-${PLATFORM}-\\d+$`);

/** Code cache files of earlier releases, one per chunk and build. */
const LEGACY_CACHE_FILE_SUFFIX = `-${PLATFORM}.bin`;

/** The oldest Node major version {@link canLoadChunks} accepts. */
const MIN_NODE_MAJOR = 22;

/**
 * Whether this runtime can run chunks with {@link createChunkLoader}. Without
 * `USE_MAIN_CONTEXT_DEFAULT_LOADER` (Node < 20.12), a chunk could not
 * `import()` anything, and Node 20 loses it for a script compiled from a
 * code cache (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`). Bun reports a new
 * Node version but does not implement `cachedDataVersionTag`. The standalone
 * binary embeds a newer Node, so only the npm package runs without it.
 */
export function canLoadChunks(
  versions: NodeJS.ProcessVersions = process.versions,
): boolean {
  return (
    versions.bun === undefined &&
    Number.parseInt(versions.node, 10) >= MIN_NODE_MAJOR &&
    constants?.USE_MAIN_CONTEXT_DEFAULT_LOADER !== undefined
  );
}

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

/**
 * Delete all but the {@link MAX_CACHED_BUILDS} newest code cache directories
 * of this platform, and the cache files of earlier releases. Caches for
 * other architectures belong to other binaries sharing the directory, so
 * they are left alone.
 */
function pruneCodeCaches(cacheDir: string): void {
  const builds: { path: string; mtime: number }[] = [];
  for (const entry of readdirSync(cacheDir)) {
    const path = join(cacheDir, entry);
    if (entry.endsWith(LEGACY_CACHE_FILE_SUFFIX)) {
      rmSync(path, { force: true });
    } else if (PLATFORM_CACHE_DIR_RE.test(entry)) {
      builds.push({ path, mtime: statSync(path).mtimeMs });
    }
  }
  builds.sort((a, b) => b.mtime - a.mtime);
  for (const { path } of builds.slice(MAX_CACHED_BUILDS)) {
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Write the code cache of each script in `scripts` to `buildDir`, then prune
 * old builds. Each rename is atomic, so a concurrent run never reads a
 * partial file.
 */
function writeCodeCaches(
  cacheDir: string,
  buildDir: string,
  scripts: ReadonlyMap<string, Script>,
): void {
  try {
    mkdirSync(buildDir, { recursive: true, mode: 0o700 });
    for (const [name, script] of scripts) {
      const path = join(buildDir, `${name}.bin`);
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, script.createCachedData(), { mode: 0o600 });
      renameSync(temporary, path);
    }
    pruneCodeCaches(cacheDir);
  } catch (error) {
    reportCodeCacheError(
      `Could not write the code cache to ${buildDir}`,
      error,
    );
  }
}

const onProcessExit: OnExit = (callback) => {
  process.once("exit", callback);
};

/** The `require` chunks run with: chunks by name, the rest from `source`. */
function chunkRequire(
  source: ChunkSource,
  chunks: ReadonlySet<string>,
  load: (name: string) => unknown,
): NodeJS.Require {
  const require = (specifier: string): unknown => {
    const name = specifier.startsWith("./") ? specifier.slice(2) : undefined;
    return name !== undefined && chunks.has(name)
      ? load(name)
      : source.require(specifier);
  };
  const { resolve, cache, main, extensions } = source.require;
  return Object.assign(require, { resolve, cache, main, extensions });
}

/**
 * Create a function that runs a chunk of `build` once and returns its
 * exports, loading the chunks it requires the same way.
 *
 * `cacheDir` holds the code caches, in a directory per build and platform.
 * When it is `undefined`, chunks compile from source every time. When a
 * chunk has no accepted cache, `onExit` gets the callback that writes the
 * caches of all such chunks.
 */
export function createChunkLoader(
  build: ChunkBuild,
  source: ChunkSource,
  cacheDir: string | undefined,
  onExit: OnExit = onProcessExit,
): (name: string) => unknown {
  // A shared config directory can serve binaries for several platforms (an
  // x64 binary under Rosetta next to an arm64 one), and V8 rejects a cache
  // made for another CPU, V8 version, or set of V8 flags.
  const buildDir =
    cacheDir === undefined
      ? undefined
      : join(cacheDir, `${build.id}-${PLATFORM}-${cachedDataVersionTag()}`);
  const modules = new Map<string, NodeJS.Module>();
  const uncached = new Map<string, Script>();
  suppressLoaderWarning();

  const load = (name: string): unknown => {
    const loaded = modules.get(name);
    if (loaded) {
      return loaded.exports;
    }
    const { filename, dirname } = source.scope(name);
    const module = {
      exports: {},
      id: filename,
      filename,
      path: dirname,
      loaded: false,
      children: [],
      paths: [],
    } as unknown as NodeJS.Module;
    modules.set(name, module);

    const cachedData =
      buildDir === undefined
        ? undefined
        : readCodeCache(join(buildDir, `${name}.bin`));
    const script = new Script(
      `${WRAPPER_HEAD}${source.read(name)}${WRAPPER_TAIL}`,
      {
        filename: source.filename(name),
        lineOffset: -1,
        cachedData,
        importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      },
    );
    if (
      buildDir !== undefined &&
      cacheDir !== undefined &&
      (cachedData === undefined || script.cachedDataRejected)
    ) {
      // On exit the cache also holds the functions compiled while the
      // command ran, not only the top level.
      if (uncached.size === 0) {
        onExit(() => writeCodeCaches(cacheDir, buildDir, uncached));
      }
      uncached.set(name, script);
    }

    const run = script.runInThisContext() as (
      exports: unknown,
      require: NodeJS.Require,
      module: NodeJS.Module,
      filename: string,
      dirname: string,
    ) => void;
    try {
      run.call(
        module.exports,
        module.exports,
        requireChunk,
        module,
        filename,
        dirname,
      );
    } catch (error) {
      // Like Node's loader: the next require runs the chunk again
      modules.delete(name);
      throw error;
    }
    module.loaded = true;
    return module.exports;
  };
  const requireChunk = chunkRequire(source, new Set(build.chunks), load);
  return load;
}
