/**
 * Code-split builds of the CLI, shared by the npm package (`script/bundle.ts`)
 * and the standalone binary (`script/build.ts`).
 *
 * esbuild only splits ESM, so a CommonJS build takes two passes:
 *
 * 1. Bundle the entry points as ESM with splitting, and write the result to
 *    a scratch directory. Every `import()` becomes its own chunk, and so does
 *    every module that a lazy `require()` loads (see {@link lazyRequirePlugin}):
 *    the CLI loads telemetry, syntax highlighting, the `--fields` parser, and
 *    the WASM SQLite driver with `require()` on first use, so they stay out of
 *    the chunks a command loads at startup.
 * 2. Convert each chunk to CommonJS without bundling. esbuild reads the
 *    sourcemaps of pass 1, so the final sourcemaps point at the sources.
 *
 * An ESM build (the library's `index.mjs`) is a single pass with splitting.
 *
 * Chunks require each other by file name (`require("./chunk-ABC.cjs")`), so
 * Node loads them from the package directory, and `src/lib/chunk-loader.ts`
 * resolves them from files or SEA assets.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  type BuildOptions,
  type BuildResult,
  build,
  type Metafile,
  type Plugin,
} from "esbuild";

/** What {@link buildSplitBundle} builds. */
export type SplitBundleOptions<Name extends string = string> = {
  /** Entry modules by output name: `{ cli: "./src/bin.ts" }` writes `cli.cjs`. */
  readonly entryPoints: Readonly<Record<Name, string>>;
  readonly outdir: string;
  /** `cjs` writes `.cjs` files, `esm` writes `.mjs` files. */
  readonly format: "cjs" | "esm";
  /**
   * CommonJS only: files whose `require()` calls of bundled modules are lazy,
   * the ones the `require-alias` plugin rewrites. Each module they require
   * becomes an entry point of its own.
   */
  readonly lazyRequireImporters?: RegExp;
  /** esbuild options for every pass: target, define, external, plugins, ... */
  readonly options: BuildOptions;
};

/** The files {@link buildSplitBundle} wrote. */
export type SplitBundle<Name extends string = string> = {
  /** The output file of each entry point, by name. */
  readonly entries: Readonly<Record<Name, string>>;
  /** Every JavaScript file written: entry points, lazy modules, and chunks. */
  readonly files: readonly string[];
};

/** Namespace of the generated entry points of lazily required modules. */
const LAZY_NAMESPACE = "sentry-lazy-require";
/** Prefix of their entry point specifiers, before the module's path. */
const LAZY_ENTRY_PREFIX = `${LAZY_NAMESPACE}:`;
const LAZY_ENTRY_RE = new RegExp(`^${LAZY_ENTRY_PREFIX}`);

const ANY_RE = /.*/;

/** Characters that may not appear in an entry point name. */
const UNSAFE_NAME_RE = /[^\w-]+/g;
const EXTENSION_RE = /\.[cm]?[jt]sx?$/;

/**
 * Prefix of the scratch directory of pass 1, next to the output directory
 * (`.split-dist` for `dist`). Ignored by git.
 */
const SCRATCH_PREFIX = ".split-";

/** Helper that a lowered `import()` of a chunk calls, see {@link lowerChunkImports}. */
const LOAD_HELPER = "__load";

/**
 * Defines {@link LOAD_HELPER} in each CommonJS chunk. Same result as
 * `import()` of a chunk: a promise of its exports. A function declaration
 * is hoisted, so it can go after the code, where it leaves the chunk's
 * `"use strict"` directive and line numbers alone.
 */
const LOAD_HELPER_FOOTER = `function ${LOAD_HELPER}(s){return Promise.resolve().then(()=>require(s))}`;

/** JavaScript files of an earlier build, and their sourcemaps. */
const BUNDLE_OUTPUT_RE = /\.[cm]js(?:\.map)?$/;

/**
 * Lazily required modules become entry points named after the specifier:
 * `require("cli-highlight")` loads `lazy-cli-highlight.cjs`.
 */
function lazyEntryName(specifier: string, taken: ReadonlySet<string>): string {
  const base = `lazy-${basename(specifier).replace(EXTENSION_RE, "").replace(UNSAFE_NAME_RE, "-")}`;
  let name = base;
  for (let index = 2; taken.has(name); index += 1) {
    name = `${base}-${index}`;
  }
  return name;
}

/**
 * Turn lazy `require()` calls into split points.
 *
 * A `require()` from a file matching `importers` that resolves to a bundled
 * module becomes `require("./lazy-<name>.cjs")`: the module is an entry
 * point of its own, which re-exports it as its default export (pass 2 turns
 * that back into `module.exports`). Modules not yet in `lazyEntries` are
 * added to `discovered`, and the caller builds again with them.
 */
function lazyRequirePlugin(
  importers: RegExp,
  lazyEntries: ReadonlyMap<string, string>,
  discovered: Map<string, string>,
): Plugin {
  return {
    name: "lazy-require",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: ANY_RE }, async (args) => {
        if (
          args.kind !== "require-call" ||
          args.namespace === LAZY_NAMESPACE ||
          args.pluginData === LAZY_NAMESPACE ||
          isBuiltin(args.path) ||
          !importers.test(args.importer)
        ) {
          return;
        }
        const resolved = await pluginBuild.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          pluginData: LAZY_NAMESPACE,
        });
        if (resolved.errors.length > 0 || resolved.external) {
          return;
        }
        const name = lazyEntries.get(resolved.path);
        if (name === undefined) {
          discovered.set(resolved.path, args.path);
          return;
        }
        return { path: `./${name}.cjs`, external: true };
      });

      // The entry point of a lazily required module, by absolute path
      pluginBuild.onResolve({ filter: LAZY_ENTRY_RE }, (args) =>
        args.kind === "entry-point"
          ? {
              path: args.path.slice(LAZY_ENTRY_PREFIX.length),
              namespace: LAZY_NAMESPACE,
            }
          : undefined,
      );
      pluginBuild.onLoad(
        { filter: ANY_RE, namespace: LAZY_NAMESPACE },
        (args) => ({
          contents: `export default require(${JSON.stringify(args.path)});`,
          resolveDir: dirname(args.path),
          loader: "js",
        }),
      );
    },
  };
}

/**
 * Pass 1 of a CommonJS build: ESM chunks with `.cjs` names, in memory.
 *
 * Builds for `options.outdir`, so plugins that write next to the output
 * (the Ink sidecar) write there, and builds again until every lazily
 * required module is an entry point.
 */
async function buildEsmChunks(options: SplitBundleOptions): Promise<{
  result: BuildResult<{ metafile: true; write: false }>;
  lazyNames: ReadonlySet<string>;
}> {
  const importers = options.lazyRequireImporters;
  const lazyEntries = new Map<string, string>();
  for (;;) {
    const discovered = new Map<string, string>();
    const lazyPoints = Object.fromEntries(
      [...lazyEntries].map(([path, name]) => [
        name,
        `${LAZY_ENTRY_PREFIX}${path}`,
      ]),
    );
    const result = await build({
      ...options.options,
      entryPoints: { ...options.entryPoints, ...lazyPoints },
      bundle: true,
      format: "esm",
      splitting: true,
      outdir: options.outdir,
      entryNames: "[name]",
      chunkNames: "chunk-[hash]",
      outExtension: { ".js": ".cjs" },
      metafile: true,
      write: false,
      plugins: [
        ...(importers
          ? [lazyRequirePlugin(importers, lazyEntries, discovered)]
          : []),
        ...(options.options.plugins ?? []),
      ],
    });
    if (discovered.size === 0) {
      return { result, lazyNames: new Set(lazyEntries.values()) };
    }
    for (const [path, specifier] of discovered) {
      lazyEntries.set(
        path,
        lazyEntryName(specifier, new Set(lazyEntries.values())),
      );
    }
  }
}

/**
 * Replace each `import("./chunk-ABC.cjs")` in a pass 1 output with
 * `__load("./chunk-ABC.cjs")`, which `require`s the chunk once it is
 * CommonJS. Other `import()` calls, like the one that loads the Ink UI (an
 * ES module with top-level await), stay as they are.
 *
 * `__load` is as long as `import`, so the sourcemap of pass 1 stays valid.
 * Every chunk the metafile says `file` imports dynamically must be replaced.
 */
function lowerChunkImports(
  file: string,
  content: string,
  output: Metafile["outputs"][string] | undefined,
): string {
  // The metafile lists a chunk once per `import()` of it
  const targets = new Set(
    (output?.imports ?? [])
      .filter((entry) => entry.kind === "dynamic-import" && !entry.external)
      .map((entry) => basename(entry.path)),
  );
  let lowered = content;
  for (const target of targets) {
    const call = `import("./${target}")`;
    if (!lowered.includes(call)) {
      throw new Error(`Could not find ${call} in ${file}`);
    }
    lowered = lowered.replaceAll(
      call,
      `${LOAD_HELPER}${call.slice("import".length)}`,
    );
  }
  return lowered;
}

/**
 * Write the pass 1 output to `scratch`, a sibling of `outdir`: at the same
 * depth, its sourcemaps' relative `sources` still resolve.
 */
async function writeEsmChunks(
  options: SplitBundleOptions,
  result: BuildResult<{ metafile: true; write: false }>,
  scratch: string,
): Promise<string[]> {
  const outdir = resolve(options.outdir);
  const outputs = new Map(
    Object.entries(result.metafile.outputs).map(([file, output]) => [
      resolve(file),
      output,
    ]),
  );
  await mkdir(scratch, { recursive: true });
  const files: string[] = [];
  for (const file of result.outputFiles) {
    const target = join(scratch, relative(outdir, file.path));
    if (file.path.endsWith(".map")) {
      await writeFile(target, file.contents);
      continue;
    }
    await writeFile(
      target,
      lowerChunkImports(file.path, file.text, outputs.get(file.path)),
    );
    files.push(target);
  }
  return files;
}

/** Pass 2 of a CommonJS build: convert the ESM chunks in `files` to CommonJS. */
async function convertToCommonJs(
  options: SplitBundleOptions,
  files: string[],
  outbase: string,
  footer?: string,
): Promise<string[]> {
  if (files.length === 0) {
    return [];
  }
  const { target, minify, sourcemap, logLevel } = options.options;
  const result = await build({
    entryPoints: files,
    outbase,
    outdir: options.outdir,
    bundle: false,
    platform: "node",
    format: "cjs",
    target,
    minify,
    sourcemap,
    logLevel,
    loader: { ".cjs": "js" },
    outExtension: { ".js": ".cjs" },
    footer: {
      js: footer ? `${LOAD_HELPER_FOOTER}\n${footer}` : LOAD_HELPER_FOOTER,
    },
    metafile: true,
  });
  return Object.keys(result.metafile.outputs).filter((file) =>
    file.endsWith(".cjs"),
  );
}

/** Files written by a build, without sourcemaps. */
function jsOutputs(metafile: Metafile): string[] {
  return Object.keys(metafile.outputs).filter((file) => !file.endsWith(".map"));
}

/**
 * Delete the JavaScript files and sourcemaps in `dir`. Chunk names hash
 * their content, so a build does not overwrite the chunks of the last one.
 */
export async function removeBundleOutputs(dir: string): Promise<void> {
  for (const entry of await readdir(dir).catch(() => [])) {
    if (BUNDLE_OUTPUT_RE.test(entry)) {
      await rm(join(dir, entry), { force: true });
    }
  }
}

/** Build `options.entryPoints` into split chunks, see the module comment. */
export async function buildSplitBundle<Name extends string>(
  options: SplitBundleOptions<Name>,
): Promise<SplitBundle<Name>> {
  const extension = options.format === "cjs" ? ".cjs" : ".mjs";
  const entries = Object.fromEntries(
    Object.keys(options.entryPoints).map((name) => [
      name,
      join(options.outdir, `${name}${extension}`),
    ]),
  ) as Record<Name, string>;

  if (options.format === "esm") {
    const result = await build({
      ...options.options,
      entryPoints: options.entryPoints,
      bundle: true,
      format: "esm",
      splitting: true,
      outdir: options.outdir,
      entryNames: "[name]",
      chunkNames: "chunk-[hash]",
      outExtension: { ".js": ".mjs" },
      metafile: true,
    });
    return { entries, files: jsOutputs(result.metafile) };
  }

  const scratch = join(
    dirname(options.outdir),
    `${SCRATCH_PREFIX}${basename(options.outdir)}`,
  );
  await rm(scratch, { recursive: true, force: true });
  try {
    const { result, lazyNames } = await buildEsmChunks(options);
    const esmFiles = await writeEsmChunks(options, result, scratch);
    const isLazy = (file: string) => lazyNames.has(basename(file, ".cjs"));
    const files = [
      ...(await convertToCommonJs(
        options,
        esmFiles.filter((file) => !isLazy(file)),
        scratch,
      )),
      // A lazily required module's entry point exports it as `default`
      ...(await convertToCommonJs(
        options,
        esmFiles.filter(isLazy),
        scratch,
        "module.exports=module.exports.default;",
      )),
    ];
    return { entries, files };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
