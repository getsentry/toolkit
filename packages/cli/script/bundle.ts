#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { type BuildOptions, build, type Plugin } from "esbuild";
import pkg from "../package.json";
import {
  buildMainScript,
  chunkBuild,
  deleteSourcemaps,
  injectDebugIds,
  uploadChunkSourcemaps,
} from "./lib/chunk-build.js";
import {
  REQUIRE_ALIAS_FILTER,
  requireAliasPlugin,
} from "./lib/require-alias-plugin.js";
import { buildSplitBundle, removeBundleOutputs } from "./lib/split-bundle.js";
import { zodEnglishLocalesPlugin } from "./lib/zod-locales-plugin.js";
import { zodV3StubPlugin } from "./lib/zod-v3-stub-plugin.js";
import { buildCoreDeclarations, SDK_TYPES_PATH } from "./sdk-declarations.js";
import { textImportPlugin } from "./text-import-plugin.js";

const VERSION = pkg.version;
/** Optional OAuth client ID override; unset uses the default in src/lib/oauth.ts. */
const SENTRY_CLIENT_ID = process.env.SENTRY_CLIENT_ID;

console.log(`\nBundling sentry v${VERSION} for npm`);
console.log("=".repeat(40));

const IDENTIFIER_FILTER_RE = /^[A-Za-z_$][\w$]*$/;
// Match both the prefixed and bare specifiers — bundled dependencies (e.g.
// binpatch) import from "zlib", which esbuild also treats as external builtin.
const NODE_ZLIB_RE = /^(?:node:)?zlib$/;
const ANY_RE = /.*/;

/**
 * ESM-only: make `node:zlib` imports resolve through a namespace shim so that
 * named imports of version-gated exports (the `zstd*` family, added in Node
 * 22.15) become dynamic property reads instead of static named imports.
 *
 * In the CJS build these are `require("node:zlib").zstdCompress` — a lazy
 * property that is simply `undefined` on older Node, which the code
 * feature-detects and falls back to gzip. In ESM, esbuild hoists them to
 * `import { zstdCompress } from "node:zlib"`, which Node validates at link
 * time; on Node < 22.15 the missing export makes the WHOLE module fail to
 * load, breaking the package's advertised Node 18+ support. Routing through
 * `import * as zlib` keeps every access dynamic and link-safe.
 */
const zlibNamespaceShimPlugin: Plugin = {
  name: "zlib-namespace-shim",
  setup(b) {
    const NS = "sentry:node-zlib-shim";

    // Re-export every name node:zlib exposes on the (newest) build runtime plus
    // the zstd family, each as a dynamic property read. The build node is a
    // superset of older runtimes, so this covers every name any consumer imports
    // (createGzip, brotli*, zstd*, …); names absent at runtime read as undefined,
    // which the code feature-detects. `\bimport`/valid-identifier filtering keeps
    // the generated module syntactically valid.
    const zlibExportNames = Object.keys(require("node:zlib"));
    const names = new Set(
      [
        ...zlibExportNames,
        "zstdCompress",
        "zstdCompressSync",
        "zstdDecompress",
        "zstdDecompressSync",
        "createZstdCompress",
        "createZstdDecompress",
      ].filter((n) => IDENTIFIER_FILTER_RE.test(n) && n !== "default"),
    );

    // Redirect node:zlib to the shim — EXCEPT the shim's own re-export below,
    // which must reach the real builtin (otherwise it resolves to itself and
    // every member reads back as undefined). esbuild marks the real builtin
    // external so it stays a runtime lookup.
    b.onResolve({ filter: NODE_ZLIB_RE }, (args) =>
      args.namespace === NS
        ? { path: "node:zlib", external: true }
        : { path: NS, namespace: NS },
    );

    b.onLoad({ filter: ANY_RE, namespace: NS }, () => ({
      contents: [
        `import * as zlib from "node:zlib";`,
        "export default zlib;",
        ...[...names].map(
          (n) => `export const ${n} = zlib[${JSON.stringify(n)}];`,
        ),
      ].join("\n"),
      loader: "js",
    }));
  },
};

const plugins: Plugin[] = [
  zodEnglishLocalesPlugin,
  zodV3StubPlugin,
  textImportPlugin,
  requireAliasPlugin,
];

if (process.env.SENTRY_AUTH_TOKEN) {
  console.log("  Sentry auth token found, source maps will be uploaded");
} else {
  console.log(
    "  No SENTRY_AUTH_TOKEN, debug IDs will be injected but source maps will not be uploaded",
  );
}

// Options shared by the CJS and ESM builds. Only the module format, the
// entry points, and format-specific interop shims differ between them.
const commonBuildOptions = {
  bundle: true,
  minify: true,
  treeShaking: true,
  // No banner (beyond format shims) — warning suppression lives in
  // dist/bin.cjs (CLI-only). The library must not suppress the host app's
  // warnings.
  sourcemap: true,
  platform: "node",
  // Target Node.js 18 — the published package's floor (engines.node).
  // Older Node.js uses the bundled WASM SQLite driver (node-sqlite3-wasm);
  // 22.15+ uses the native node:sqlite. Downlevels newer syntax accordingly.
  target: "node18",
  // Externalize Node.js built-ins, plus Ink + React + companions.
  // These packages are NOT bundled into the main output because they use
  // top-level await (esbuild can't emit that in CJS). Instead, the Ink UI
  // lives in a separate self-contained ESM sidecar (`dist/ink-app.js`) that
  // the text-import-plugin pre-bundles with all deps inlined. The main bundle
  // references the sidecar via a path string and loads it lazily via dynamic
  // `import()` at runtime. The external list here prevents esbuild from trying
  // to resolve these packages in the main bundle graph.
  external: [
    "node:*",
    // The DIF loader resolves this .wasm at runtime (dev only); never bundle it.
    "@sentry/symbolic/symbolic_bg.wasm",
    "ink",
    "react",
    "react/*",
    "react-reconciler",
    "react-reconciler/*",
    "react-devtools-core",
    "yoga-layout",
  ],
  plugins,
} satisfies BuildOptions;

// Defines shared by both formats. The CJS build additionally rewrites
// `import.meta.url` to a shim; the ESM build uses it natively.
const commonDefine: Record<string, string> = {
  SENTRY_CLI_VERSION: JSON.stringify(VERSION),
  ...(SENTRY_CLIENT_ID && {
    SENTRY_CLIENT_ID_BUILD: JSON.stringify(SENTRY_CLIENT_ID),
  }),
  "process.env.NODE_ENV": JSON.stringify("production"),
  // Tree-shakes the SDK's runtime module hooks, which can't instrument a
  // bundle and would hook the host app in library mode.
  __SENTRY_CHANNEL_INJECTION__: "false",
  // `true` only in `dist/complete.cjs`: drops the lazy telemetry `require`
  // (and `@sentry/node`) from `src/lib/db/index.ts` there.
  SENTRY_CLI_COMPLETION_BUILD: "false",
};

/** Options of the CommonJS builds, which shim `import.meta.url`. */
const cjsBuildOptions = {
  ...commonBuildOptions,
  inject: ["./script/import-meta-url.js"],
  define: { ...commonDefine, "import.meta.url": "import_meta_url" },
} satisfies BuildOptions;

// In an ESM bundle, `require`, `__dirname`, and `__filename` don't exist, but
// the inlined `node-sqlite3-wasm` Emscripten glue (and other lazily-required
// modules) still reference them. Recreate them from `import.meta.url` so the
// WASM SQLite fallback resolves `dist/node-sqlite3-wasm.wasm` correctly.
const ESM_INTEROP_BANNER = [
  `import { createRequire as __sentryCreateRequire } from "node:module";`,
  `import { fileURLToPath as __sentryFileURLToPath } from "node:url";`,
  `import { dirname as __sentryDirname } from "node:path";`,
  "const require = __sentryCreateRequire(import.meta.url);",
  "const __filename = __sentryFileURLToPath(import.meta.url);",
  "const __dirname = __sentryDirname(__filename);",
].join("\n");

const DIST = "./dist";

await removeBundleOutputs(DIST);

// The CLI (`dist/cli.cjs`, which `dist/bin.cjs` runs) and the CommonJS
// library (`dist/index.cjs`) share their chunks, and every command is a
// chunk of its own, so a run loads only the code it uses.
const cjs = await buildSplitBundle({
  entryPoints: { cli: "./src/bin.ts", index: "./src/index.ts" },
  outdir: DIST,
  format: "cjs",
  lazyRequireImporters: REQUIRE_ALIAS_FILTER,
  options: cjsBuildOptions,
});

// `sentry __complete` runs on every TAB press, so it gets a single small
// file that shares nothing with the CLI's chunks.
const COMPLETE_CJS = join(DIST, "complete.cjs");
await build({
  ...cjsBuildOptions,
  entryPoints: ["./src/complete-bin.ts"],
  format: "cjs",
  outfile: COMPLETE_CJS,
  define: { ...cjsBuildOptions.define, SENTRY_CLI_COMPLETION_BUILD: "true" },
});

// The ES module library (`dist/index.mjs`): split the same way, so an app
// that imports the SDK loads only the commands it calls.
const esm = await buildSplitBundle({
  entryPoints: { index: "./src/index.ts" },
  outdir: DIST,
  format: "esm",
  options: {
    ...commonBuildOptions,
    // ESM has native import.meta.url and needs no injected shims.
    define: commonDefine,
    banner: { js: ESM_INTEROP_BANNER },
    // ESM-only: keep node:zlib access dynamic so version-gated zstd exports
    // don't become link-time-fatal named imports on Node < 22.15 (see the
    // plugin comment).
    plugins: [...plugins, zlibNamespaceShimPlugin],
  },
});

const cjsFiles = [...cjs.files, COMPLETE_CJS];
const jsFiles = [...cjsFiles, ...esm.files];

// Always inject debug IDs (even without auth token); upload needs a token.
const injected = await injectDebugIds(jsFiles);
console.log(`  Debug IDs injected into ${injected.length} files`);
if (process.env.SENTRY_AUTH_TOKEN && injected.length > 0) {
  // Only delete .map files after a successful upload — preserving them on
  // failure allows retrying without a full rebuild.
  if (
    await uploadChunkSourcemaps(injected, { release: VERSION, urlPrefix: "~/" })
  ) {
    await deleteSourcemaps(injected);
  }
}

// The CLI bin: shebang, version check, warning suppression, then
// `src/chunk-main.ts`, which runs `cli.cjs` or `complete.cjs` with a code
// cache. Built after debug ID injection, because the build ID it embeds
// hashes the chunks' final content. Version floor must track `engines.node`
// in package.json.
const BIN_BANNER = `#!/usr/bin/env node
{let v=process.versions.node.split(".").map(Number);if(v[0]<18){console.error("Error: sentry requires Node.js 18 or later (found "+process.version+").\\n\\nEither upgrade Node.js, or install the standalone binary instead:\\n  curl -fsSL https://cli.sentry.dev/install | bash\\n");process.exit(1)}}
{let e=process.emit;process.emit=function(n,...a){return n==="warning"?!1:e.apply(this,[n,...a])}}`;
const BIN_CJS = join(DIST, "bin.cjs");
await buildMainScript({
  outfile: BIN_CJS,
  chunks: await chunkBuild(cjsFiles, {
    cli: basename(cjs.entries.cli),
    complete: basename(COMPLETE_CJS),
  }),
  target: commonBuildOptions.target,
  banner: BIN_BANNER,
});
await chmod(BIN_CJS, 0o755);

// Write TypeScript declarations for the library API.
// The SentrySDK type is read from sdk.generated.d.cts (produced by generate-sdk.ts), and
// SentryOptions from sdk-types.ts so the published type cannot drift from the source.
const CORE_DECLARATIONS = buildCoreDeclarations(
  await readFile(`./${SDK_TYPES_PATH}`, "utf-8"),
);

// Read pre-built SDK type declarations (generated by generate-sdk.ts)
const sdkTypes = await readFile("./src/sdk.generated.d.cts", "utf-8");

const TYPE_DECLARATIONS = `${CORE_DECLARATIONS}\n${sdkTypes}\n`;
// The declarations are self-contained (no relative imports), so the same content
// serves both module systems: `.d.cts` for the `require` condition and `.d.mts`
// for the `import` condition.
await writeFile("./dist/index.d.cts", TYPE_DECLARATIONS);
await writeFile("./dist/index.d.mts", TYPE_DECLARATIONS);

console.log("  -> dist/bin.cjs (CLI main script)");
console.log("  -> dist/index.d.cts + dist/index.d.mts (type declarations)");

// The `ink-app.js` sidecar (pre-bundled by text-import-plugin) ships
// with the npm package so `npx sentry@latest init` can load the
// interactive Ink UI on Node via dynamic import(). The sidecar is
// self-contained ESM with all deps inlined — no runtime dependencies
// needed.

// Ship the DIF parser WASM as a sibling of the bundle. The runtime loads it
// (non-SEA path) via new URL("./vendor/symbolic_bg.wasm", import.meta.url),
// which resolves relative to the chunk in dist/ (see src/lib/dif/index.ts).
await mkdir("./dist/vendor", { recursive: true });
await copyFile(
  // Resolve via module resolution rather than a fixed node_modules path:
  // in the pnpm workspace @sentry/symbolic may live in the isolated store.
  createRequire(import.meta.url).resolve("@sentry/symbolic/symbolic_bg.wasm"),
  "./dist/vendor/symbolic_bg.wasm",
);
console.log("  -> dist/vendor/symbolic_bg.wasm (DIF parser)");

// Ship the Spleen glyph subset next to the npm bundle. The formatter resolves
// it via new URL("./assets/spleen-8x16.bin", import.meta.url), relative to
// the chunk in dist/ (see src/lib/formatters/spleen-font.ts).
await mkdir("./dist/assets", { recursive: true });
await copyFile(
  "./src/lib/formatters/assets/spleen-8x16.bin",
  "./dist/assets/spleen-8x16.bin",
);
console.log("  -> dist/assets/spleen-8x16.bin (dashboard font)");

// Ship the WASM SQLite driver's .wasm next to the bundle. The driver JS
// (node-sqlite3-wasm) is a chunk in dist/ (lazy-node-sqlite3-wasm.cjs), and its
// Emscripten glue locates the .wasm via `__dirname + "/node-sqlite3-wasm.wasm"`.
// Once bundled, `__dirname` is `dist/`, so the file must sit at
// dist/node-sqlite3-wasm.wasm. Only loaded on Node.js < 22.15 (see
// src/lib/db/sqlite.ts resolveDriver()); harmless dead weight on newer Node.
let sqliteWasmSrc: string;
try {
  sqliteWasmSrc = createRequire(import.meta.url).resolve(
    "node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm",
  );
} catch {
  throw new Error(
    "Missing node-sqlite3-wasm WASM (node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm). Run: pnpm install",
  );
}
if (!existsSync(sqliteWasmSrc)) {
  throw new Error(
    `Missing node-sqlite3-wasm WASM at ${sqliteWasmSrc}. Run: pnpm install`,
  );
}
await copyFile(sqliteWasmSrc, "./dist/node-sqlite3-wasm.wasm");
console.log("  -> dist/node-sqlite3-wasm.wasm (WASM SQLite fallback)");

/** Total size of `files` in KB. */
async function sizeKb(files: readonly string[]): Promise<string> {
  const sizes = await Promise.all(
    files.map(async (file) => (await stat(file)).size),
  );
  return (sizes.reduce((a, b) => a + b, 0) / 1024).toFixed(1);
}

console.log(
  `\n  -> dist/cli.cjs + dist/index.cjs: ${cjs.files.length} files (${await sizeKb(cjs.files)} KB)`,
);
console.log(
  `  -> dist/index.mjs: ${esm.files.length} files (${await sizeKb(esm.files)} KB)`,
);
console.log(`  -> dist/complete.cjs (${await sizeKb([COMPLETE_CJS])} KB)`);
console.log(`\n${"=".repeat(40)}`);
console.log("Bundle complete!");
