#!/usr/bin/env tsx
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build, type Plugin } from "esbuild";
import pkg from "../package.json";
import { uploadSourcemaps } from "../src/lib/api/sourcemaps.js";
import { injectDebugId, PLACEHOLDER_DEBUG_ID } from "./debug-id.js";
import { buildCoreDeclarations, SDK_TYPES_PATH } from "./sdk-declarations.js";
import { textImportPlugin } from "./text-import-plugin.js";

const VERSION = pkg.version;
const SENTRY_CLIENT_ID = process.env.SENTRY_CLIENT_ID ?? "";

console.log(`\nBundling sentry v${VERSION} for npm`);
console.log("=".repeat(40));

if (!SENTRY_CLIENT_ID) {
  console.error("\nError: SENTRY_CLIENT_ID environment variable is required.");
  console.error("   The CLI requires OAuth to function.");
  console.error("   Set it via: SENTRY_CLIENT_ID=xxx pnpm run bundle\n");
  process.exit(1);
}

type InjectedFile = { jsPath: string; mapPath: string; debugId: string };

/** Delete .map files after a successful upload — they shouldn't ship to users. */
async function deleteMapFiles(injected: InjectedFile[]): Promise<void> {
  for (const { mapPath } of injected) {
    try {
      await unlink(mapPath);
    } catch {
      // Ignore — file might already be gone
    }
  }
}

/** Inject debug IDs into JS outputs and their companion sourcemaps. */
async function injectDebugIdsForOutputs(
  jsFiles: string[]
): Promise<InjectedFile[]> {
  const injected: InjectedFile[] = [];
  for (const jsPath of jsFiles) {
    const mapPath = `${jsPath}.map`;
    try {
      const { debugId } = await injectDebugId(jsPath, mapPath, {
        skipSnippet: true,
      });
      injected.push({ jsPath, mapPath, debugId });
      console.log(`  Debug ID injected: ${debugId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  Warning: Debug ID injection failed for ${jsPath}: ${msg}`
      );
    }
  }
  return injected;
}

/**
 * Upload injected sourcemaps to Sentry via the chunk-upload protocol.
 *
 * @returns `true` if upload succeeded, `false` if it failed (non-fatal).
 */
async function uploadInjectedSourcemaps(
  injected: InjectedFile[]
): Promise<boolean> {
  try {
    console.log("  Uploading sourcemaps to Sentry...");
    await uploadSourcemaps({
      org: "sentry",
      project: "cli",
      release: VERSION,
      files: injected.flatMap(({ jsPath, mapPath, debugId }) => {
        const jsName = jsPath.split("/").pop() ?? "bin.cjs";
        const mapName = mapPath.split("/").pop() ?? "bin.cjs.map";
        return [
          {
            path: jsPath,
            debugId,
            type: "minified_source" as const,
            url: `~/${jsName}`,
            sourcemapFilename: mapName,
          },
          {
            path: mapPath,
            debugId,
            type: "source_map" as const,
            url: `~/${mapName}`,
          },
        ];
      }),
    });
    console.log("  Sourcemaps uploaded to Sentry");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  Warning: Sourcemap upload failed: ${msg}`);
    return false;
  }
}

/**
 * esbuild plugin that injects debug IDs and uploads sourcemaps to Sentry.
 *
 * Runs after esbuild finishes bundling (onEnd hook):
 * 1. Injects debug IDs into each JS output + its companion .map
 * 2. Uploads all artifacts to Sentry via the chunk-upload protocol
 * 3. Deletes .map files after upload (they shouldn't ship to users)
 *
 * Replaces `@sentry/esbuild-plugin` with zero external dependencies.
 */
const sentrySourcemapPlugin: Plugin = {
  name: "sentry-sourcemap",
  setup(pluginBuild) {
    pluginBuild.onEnd(async (buildResult) => {
      const outputs = Object.keys(buildResult.metafile?.outputs ?? {});
      const jsFiles = outputs.filter(
        (p) =>
          p.endsWith(".cjs") ||
          p.endsWith(".mjs") ||
          (p.endsWith(".js") && !p.endsWith(".map"))
      );

      if (jsFiles.length === 0) {
        return;
      }

      const injected = await injectDebugIdsForOutputs(jsFiles);
      if (injected.length === 0) {
        return;
      }

      // Replace the placeholder UUID with the real debug ID in each JS output.
      // Both are 36-char UUIDs so sourcemap character positions stay valid.
      for (const { jsPath, debugId } of injected) {
        const content = await readFile(jsPath, "utf-8");
        await writeFile(
          jsPath,
          content.split(PLACEHOLDER_DEBUG_ID).join(debugId)
        );
      }

      if (!process.env.SENTRY_AUTH_TOKEN) {
        return;
      }

      const uploaded = await uploadInjectedSourcemaps(injected);

      // Only delete .map files after a successful upload — preserving
      // them on failure allows retrying without a full rebuild.
      if (uploaded) {
        await deleteMapFiles(injected);
      }
    });
  },
};

// Always inject debug IDs (even without auth token); upload is gated inside the plugin
/**
 * Files that use `_require()` for lazy imports. The `require-alias` plugin
 * rewrites `_require(` → `require(` in these so esbuild resolves them at
 * bundle time. `db/sqlite` is included so the WASM SQLite fallback
 * (`node-sqlite3-wasm`) is actually inlined into the npm bundle — otherwise
 * it stays a runtime `require()` that fails in a real install (the driver is
 * a devDependency, not shipped). `node:sqlite` in the same file stays a
 * builtin and is left external by esbuild regardless.
 */
const REQUIRE_ALIAS_FILTER =
  /(?:db[\\/](?:index|schema|sqlite)|list-command|telemetry)\.ts$/;
const REQUIRE_ALIAS_RE = /\b_require\(/g;
const IDENTIFIER_FILTER_RE = /^[A-Za-z_$][\w$]*$/;
// Match both the prefixed and bare specifiers — bundled dependencies (e.g.
// binpatch) import from "zlib", which esbuild also treats as external builtin.
const NODE_ZLIB_RE = /^(?:node:)?zlib$/;
const ANY_RE = /.*/;

/** Transform _require() → require() so esbuild resolves lazy relative requires. */
const requireAliasPlugin: Plugin = {
  name: "require-alias",
  setup(b) {
    b.onLoad({ filter: REQUIRE_ALIAS_FILTER }, async (args) => {
      const source = await readFile(args.path, "utf-8");
      return {
        contents: source.replace(REQUIRE_ALIAS_RE, "require("),
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      };
    });
  },
};

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
      ].filter((n) => IDENTIFIER_FILTER_RE.test(n) && n !== "default")
    );

    // Redirect node:zlib to the shim — EXCEPT the shim's own re-export below,
    // which must reach the real builtin (otherwise it resolves to itself and
    // every member reads back as undefined). esbuild marks the real builtin
    // external so it stays a runtime lookup.
    b.onResolve({ filter: NODE_ZLIB_RE }, (args) =>
      args.namespace === NS
        ? { path: "node:zlib", external: true }
        : { path: NS, namespace: NS }
    );

    b.onLoad({ filter: ANY_RE, namespace: NS }, () => ({
      contents: [
        `import * as zlib from "node:zlib";`,
        "export default zlib;",
        ...[...names].map(
          (n) => `export const ${n} = zlib[${JSON.stringify(n)}];`
        ),
      ].join("\n"),
      loader: "js",
    }));
  },
};

const plugins: Plugin[] = [
  sentrySourcemapPlugin,
  textImportPlugin,
  requireAliasPlugin,
];

if (process.env.SENTRY_AUTH_TOKEN) {
  console.log("  Sentry auth token found, source maps will be uploaded");
} else {
  console.log(
    "  No SENTRY_AUTH_TOKEN, debug IDs will be injected but source maps will not be uploaded"
  );
}

// Options shared by both the CJS and ESM library builds. Only the module
// format, output path, and format-specific interop shims differ between them.
const commonBuildOptions = {
  entryPoints: ["./src/index.ts"],
  bundle: true,
  minify: true,
  treeShaking: true,
  // No banner (beyond format shims) — warning suppression moved to dist/bin.cjs
  // (CLI-only). The library bundle must not suppress the host app's warnings.
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
    "ink-spinner",
    "react",
    "react/*",
    "react-reconciler",
    "react-reconciler/*",
    "react-devtools-core",
    "yoga-layout",
  ],
  metafile: true,
  plugins,
} satisfies Parameters<typeof build>[0];

// Defines shared by both formats. The CJS build additionally rewrites
// `import.meta.url` to a shim; the ESM build uses it natively.
const commonDefine: Record<string, string> = {
  SENTRY_CLI_VERSION: JSON.stringify(VERSION),
  SENTRY_CLIENT_ID_BUILD: JSON.stringify(SENTRY_CLIENT_ID),
  "process.env.NODE_ENV": JSON.stringify("production"),
  __SENTRY_DEBUG_ID__: JSON.stringify(PLACEHOLDER_DEBUG_ID),
};

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

const result = await build({
  ...commonBuildOptions,
  format: "cjs",
  outfile: "./dist/index.cjs",
  // Inject the import.meta.url shim for CJS compatibility.
  inject: ["./script/import-meta-url.js"],
  define: {
    ...commonDefine,
    // Replace import.meta.url with the injected shim variable for CJS
    "import.meta.url": "import_meta_url",
  },
});

const esmResult = await build({
  ...commonBuildOptions,
  format: "esm",
  outfile: "./dist/index.mjs",
  // ESM has native import.meta.url and needs no injected shims.
  define: { ...commonDefine },
  banner: { js: ESM_INTEROP_BANNER },
  // ESM-only: keep node:zlib access dynamic so version-gated zstd exports don't
  // become link-time-fatal named imports on Node < 22.15 (see plugin comment).
  plugins: [...commonBuildOptions.plugins, zlibNamespaceShimPlugin],
});

// Write the CLI bin wrapper (tiny — shebang + version check + dispatch).
// Version floor must track `engines.node` in package.json.
const BIN_WRAPPER = `#!/usr/bin/env node
{let v=process.versions.node.split(".").map(Number);if(v[0]<18){console.error("Error: sentry requires Node.js 18 or later (found "+process.version+").\\n\\nEither upgrade Node.js, or install the standalone binary instead:\\n  curl -fsSL https://cli.sentry.dev/install | bash\\n");process.exit(1)}}
{let e=process.emit;process.emit=function(n,...a){return n==="warning"?!1:e.apply(this,[n,...a])}}
require('./index.cjs')._cli().catch(()=>{process.exitCode=1});
`;
await writeFile("./dist/bin.cjs", BIN_WRAPPER);

// Write TypeScript declarations for the library API.
// The SentrySDK type is read from sdk.generated.d.cts (produced by generate-sdk.ts), and
// SentryOptions from sdk-types.ts so the published type cannot drift from the source.
const CORE_DECLARATIONS = buildCoreDeclarations(
  await readFile(`./${SDK_TYPES_PATH}`, "utf-8")
);

// Read pre-built SDK type declarations (generated by generate-sdk.ts)
const sdkTypes = await readFile("./src/sdk.generated.d.cts", "utf-8");

const TYPE_DECLARATIONS = `${CORE_DECLARATIONS}\n${sdkTypes}\n`;
// The declarations are self-contained (no relative imports), so the same content
// serves both module systems: `.d.cts` for the `require` condition and `.d.mts`
// for the `import` condition.
await writeFile("./dist/index.d.cts", TYPE_DECLARATIONS);
await writeFile("./dist/index.d.mts", TYPE_DECLARATIONS);

console.log("  -> dist/bin.cjs (CLI wrapper)");
console.log("  -> dist/index.d.cts + dist/index.d.mts (type declarations)");

// The `ink-app.js` sidecar (pre-bundled by text-import-plugin) ships
// with the npm package so `npx sentry@latest init` can load the
// interactive Ink UI on Node via dynamic import(). The sidecar is
// self-contained ESM with all deps inlined — no runtime dependencies
// needed.

// Ship the DIF parser WASM as a sibling of the bundle. The runtime loads it
// (non-SEA path) via new URL("./vendor/symbolic_bg.wasm", import.meta.url),
// which resolves relative to dist/index.cjs (see src/lib/dif/index.ts).
await mkdir("./dist/vendor", { recursive: true });
await copyFile(
  // Resolve via module resolution rather than a fixed node_modules path:
  // in the pnpm workspace @sentry/symbolic may live in the isolated store.
  createRequire(import.meta.url).resolve("@sentry/symbolic/symbolic_bg.wasm"),
  "./dist/vendor/symbolic_bg.wasm"
);
console.log("  -> dist/vendor/symbolic_bg.wasm (DIF parser)");

// Ship the Spleen glyph subset next to the npm bundle. The formatter resolves
// it via new URL("./assets/spleen-8x16.bin", import.meta.url), relative to
// dist/index.cjs (see src/lib/formatters/spleen-font.ts).
await mkdir("./dist/assets", { recursive: true });
await copyFile(
  "./src/lib/formatters/assets/spleen-8x16.bin",
  "./dist/assets/spleen-8x16.bin"
);
console.log("  -> dist/assets/spleen-8x16.bin (dashboard font)");

// Ship the WASM SQLite driver's .wasm next to the bundle. The driver JS
// (node-sqlite3-wasm) is inlined into dist/index.cjs by esbuild, and its
// Emscripten glue locates the .wasm via `__dirname + "/node-sqlite3-wasm.wasm"`.
// Once bundled, `__dirname` is `dist/`, so the file must sit at
// dist/node-sqlite3-wasm.wasm. Only loaded on Node.js < 22.15 (see
// src/lib/db/sqlite.ts resolveDriver()); harmless dead weight on newer Node.
let sqliteWasmSrc: string;
try {
  sqliteWasmSrc = createRequire(import.meta.url).resolve(
    "node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm"
  );
} catch {
  throw new Error(
    "Missing node-sqlite3-wasm WASM (node-sqlite3-wasm/dist/node-sqlite3-wasm.wasm). Run: pnpm install"
  );
}
if (!existsSync(sqliteWasmSrc)) {
  throw new Error(
    `Missing node-sqlite3-wasm WASM at ${sqliteWasmSrc}. Run: pnpm install`
  );
}
await copyFile(sqliteWasmSrc, "./dist/node-sqlite3-wasm.wasm");
console.log("  -> dist/node-sqlite3-wasm.wasm (WASM SQLite fallback)");

// Calculate bundle size (only the main bundle, not source maps)
const bundleSizeKB = (
  (result.metafile?.outputs["dist/index.cjs"]?.bytes ?? 0) / 1024
).toFixed(1);
const esmBundleSizeKB = (
  (esmResult.metafile?.outputs["dist/index.mjs"]?.bytes ?? 0) / 1024
).toFixed(1);

console.log(`\n  -> dist/index.cjs (${bundleSizeKB} KB)`);
console.log(`  -> dist/index.mjs (${esmBundleSizeKB} KB)`);
console.log(`\n${"=".repeat(40)}`);
console.log("Bundle complete!");
