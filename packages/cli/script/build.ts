#!/usr/bin/env tsx

/**
 * Build script for Sentry CLI
 *
 * Creates standalone executables for multiple platforms using Node SEA
 * binaries via fossilize.
 * Binaries are uploaded to GitHub Releases.
 *
 * Uses a two-step build to produce external sourcemaps for Sentry:
 * 1. Bundle TS → minified JS (esbuild): the CLI as code-split chunks, the
 *    shell-completion engine, and the main script that runs them
 *    (`src/chunk-main.ts`), the same as the npm package's `dist/bin.cjs`
 * 2. Compile JS → native SEA binary per platform (fossilize), with every
 *    chunk embedded as a SEA asset
 * 3. Upload the .map files to Sentry for server-side stack trace resolution
 *
 * Usage:
 *   pnpm run script/build.ts                        # Build for all platforms
 *   pnpm run script/build.ts --single               # Build for current platform only
 *   pnpm run script/build.ts --target darwin-x64    # Build for specific target (cross-compile)
 *
 * Output structure:
 *   dist-bin/
 *     sentry-darwin-arm64
 *     sentry-darwin-x64
 *     sentry-linux-arm64
 *     sentry-linux-x64
 *     sentry-windows-x64.exe
 *   dist-build/           (chunks and sourcemaps, embedded and uploaded)
 */

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { buildCarExtract } from "./build-car-extract.js";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { type BuildOptions, build as esbuild } from "esbuild";
import {
  buildMainScript,
  chunkBuild,
  type InjectedFile,
  injectDebugIds,
  uploadChunkSourcemaps,
} from "./lib/chunk-build.js";
import {
  REQUIRE_ALIAS_FILTER,
  requireAliasPlugin,
} from "./lib/require-alias-plugin.js";
import { buildSplitBundle } from "./lib/split-bundle.js";
import { zodEnglishLocalesPlugin } from "./lib/zod-locales-plugin.js";
import { zodV3StubPlugin } from "./lib/zod-v3-stub-plugin.js";
import { textImportPlugin } from "./text-import-plugin.js";

const gzipAsync = promisify(gzip);

const pkg = JSON.parse(await readFile("package.json", "utf-8"));
const VERSION: string = pkg.version;

/** Pin to Node 22 LTS for SEA binaries */
/** Node version for SEA binaries. "lts" resolves to the latest LTS via fossilize. */
const NODE_VERSION = "lts";

/**
 * Optional OAuth client ID override baked into the binary. When unset, the
 * binary uses the committed sentry.io default in src/lib/oauth.ts.
 */
const SENTRY_CLIENT_ID = process.env.SENTRY_CLIENT_ID;

/** Build targets configuration */
type BuildTarget = {
  os: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
};

const ALL_TARGETS: BuildTarget[] = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "win32", arch: "x64" },
];

/** Get package name for a target (uses "windows" instead of "win32") */
function getPackageName(target: BuildTarget): string {
  const platformName = target.os === "win32" ? "windows" : target.os;
  return `sentry-${platformName}-${target.arch}`;
}

/**
 * Map our BuildTarget to fossilize's platform string.
 * Fossilize uses Node's archive naming: "win" not "win32".
 */
function getFossilizePlatform(target: BuildTarget): string {
  const os = target.os === "win32" ? "win" : target.os;
  return `${os}-${target.arch}`;
}

/** Intermediate build directory for esbuild output (separate from fossilize's output). */
const BUILD_DIR = "dist-build";

/**
 * The `sentry __complete` bundle. Like every chunk, it is embedded as a SEA
 * asset under its path, which is also its filename in stack traces and the
 * URL of its uploaded sourcemap.
 */
const COMPLETE_JS = `${BUILD_DIR}/complete.cjs`;

/** The SEA main script, which runs the chunks (`src/chunk-main.ts`). */
const SEA_MAIN_JS = `${BUILD_DIR}/sea-main.js`;

/**
 * esbuild options shared by the CLI and completion bundles.
 *
 * Uses esbuild instead of Bun's bundler to avoid Bun's identifier
 * minification bug (oven-sh/bun#14585 — name collisions in minified
 * output). esbuild's minifier is more mature and produces correct
 * identifier mangling plus rich sourcemaps (27k+ names vs Bun's
 * empty names array).
 */
const BUNDLE_OPTIONS = {
  platform: "node",
  // Target Node 24 LTS. Downlevels `using` declarations (not
  // supported in CJS). Node SEA runs embedded JS as CJS.
  target: "node24",
  treeShaking: true,
  // Externalize the Ink + React stack from the esbuild bundling
  // step. The main bundle never calls `import("ink")` at runtime —
  // the sidecar is pre-bundled by text-import-plugin as a
  // self-contained JS file with ink/react inlined. Keeping these
  // external avoids pulling CJS React wrappers into the bundle.
  external: [
    "ink",
    "ink-spinner",
    "react",
    "react/*",
    "react-reconciler",
    "react-reconciler/*",
    // The DIF loader resolves this .wasm at runtime (dev only); never bundle it.
    "@sentry/symbolic/symbolic_bg.wasm",
    // WASM SQLite fallback for Node.js < 22.15. The SEA binary always
    // embeds a modern LTS Node.js (>= 22.15) and uses the native
    // node:sqlite driver, so this fallback branch is dead code here.
    // Externalizing it keeps the driver (and its ~1MB .wasm) out of the
    // binary entirely — see src/lib/db/sqlite.ts resolveDriver().
    "node-sqlite3-wasm",
  ],
  minify: true,
  sourcemap: true,
  // CJS format needs import.meta.url shimmed via inject + define.
  inject: ["./script/import-meta-url.js"],
  define: {
    "import.meta.url": "import_meta_url",
    SENTRY_CLI_VERSION: JSON.stringify(VERSION),
    ...(SENTRY_CLIENT_ID && {
      SENTRY_CLIENT_ID_BUILD: JSON.stringify(SENTRY_CLIENT_ID),
    }),
    "process.env.NODE_ENV": JSON.stringify("production"),
    // Tree-shakes the SDK's runtime module hooks, which can't instrument a
    // bundle and would hook the host app in library mode.
    __SENTRY_CHANNEL_INJECTION__: "false",
  },
  plugins: [
    textImportPlugin,
    zodEnglishLocalesPlugin,
    zodV3StubPlugin,
    // `_require()` → `require()`, so esbuild bundles the lazy requires
    requireAliasPlugin,
  ],
} satisfies BuildOptions;

/** Total size of `files`, in MB. */
async function sizeMb(files: readonly string[]): Promise<string> {
  const sizes = await Promise.all(
    files.map(async (file) => (await stat(file)).size),
  );
  return (sizes.reduce((a, b) => a + b, 0) / 1024 / 1024).toFixed(2);
}

/** The JavaScript files that step 1 writes, all embedded as SEA assets. */
type Bundle = {
  /** Every chunk, including {@link COMPLETE_JS}. */
  readonly files: readonly string[];
  /** The CLI's entry chunk (`src/bin.ts`). */
  readonly cli: string;
};

/**
 * Step 1: Bundle TypeScript sources into minified JS files with esbuild:
 * the CLI (`src/bin.ts`) as code-split chunks, the same way as the npm
 * package (`script/lib/split-bundle.ts`), and the shell-completion engine
 * (`src/complete-bin.ts`) as one file. Each has a sourcemap, which is
 * uploaded to Sentry and never shipped. The main script that runs them is
 * bundled after debug ID injection, because it embeds a hash of every chunk
 * (see {@link bundleSeaMain}).
 *
 * This runs once and is shared by all compile targets.
 */
async function bundleJs(): Promise<Bundle | undefined> {
  console.log("  Step 1: Bundling TypeScript → JS + sourcemaps...");

  try {
    const cli = await buildSplitBundle({
      entryPoints: { cli: "./src/bin.ts" },
      outdir: BUILD_DIR,
      format: "cjs",
      lazyRequireImporters: REQUIRE_ALIAS_FILTER,
      options: BUNDLE_OPTIONS,
    });
    // Completion runs with telemetry off: `SENTRY_CLI_COMPLETION_BUILD`
    // drops the lazy telemetry `require` (and `@sentry/node`) from
    // `src/lib/db/index.ts`.
    await esbuild({
      ...BUNDLE_OPTIONS,
      entryPoints: ["./src/complete-bin.ts"],
      bundle: true,
      format: "cjs",
      outfile: COMPLETE_JS,
      define: { ...BUNDLE_OPTIONS.define, SENTRY_CLI_COMPLETION_BUILD: "true" },
    });

    console.log(
      `    -> ${BUILD_DIR}/${basename(cli.entries.cli)}: ${cli.files.length} chunks (${await sizeMb(cli.files)} MB)`,
    );
    console.log(`    -> ${COMPLETE_JS} (${await sizeMb([COMPLETE_JS])} MB)`);
    return { files: [...cli.files, COMPLETE_JS], cli: cli.entries.cli };
  } catch (error) {
    console.error("  Failed to bundle JS:");
    console.error(
      `    ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
}

/**
 * Bundle the SEA main script (`src/chunk-main.ts`), which reads the chunks
 * back with `node:sea.getAsset()`. It runs after debug ID injection, so the
 * build ID it embeds hashes the chunks' final bytes: the ID names the
 * directory of their code caches, and V8 would otherwise accept a cache from
 * another build whose source has the same length.
 */
async function bundleSeaMain(bundle: Bundle): Promise<boolean> {
  try {
    await buildMainScript({
      outfile: SEA_MAIN_JS,
      chunks: await chunkBuild(bundle.files, {
        cli: basename(bundle.cli),
        complete: basename(COMPLETE_JS),
      }),
      assetDir: BUILD_DIR,
      target: BUNDLE_OPTIONS.target,
    });
    console.log(`    -> ${SEA_MAIN_JS} (SEA main script)`);
    return true;
  } catch (error) {
    console.error("  Failed to bundle the SEA main script:");
    console.error(
      `    ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * Upload the sourcemaps to Sentry. Runs after compilation. Each chunk's
 * URL is its SEA asset key, the filename of its stack frames.
 */
async function uploadSourcemapsToSentry(
  injected: readonly InjectedFile[],
): Promise<void> {
  if (injected.length === 0) {
    return;
  }
  if (!process.env.SENTRY_AUTH_TOKEN) {
    console.log("  No SENTRY_AUTH_TOKEN, skipping sourcemap upload");
    return;
  }
  await uploadChunkSourcemaps(injected, {
    release: VERSION,
    urlPrefix: `~/${BUILD_DIR}/`,
  });
}

/**
 * Step 2: Compile the pre-bundled JS into Node SEA binaries for all targets
 * using fossilize. Runs a single fossilize invocation for all platforms
 * (fossilize parallelizes internally), then post-processes each binary.
 */
async function compileAllTargets(
  targets: BuildTarget[],
  bundle: Bundle,
): Promise<{ successes: number; failures: number }> {
  const platforms = targets.map((t) => getFossilizePlatform(t));

  // The SEA main script (SEA_MAIN_JS) reads the chunks back with
  // node:sea.getAsset() under the same keys.
  const assetArgs = bundle.files.flatMap((file) => ["--assets", file]);

  // Add ink sidecar as asset if it exists (pre-bundled by text-import-plugin)
  // The text-import-plugin pre-bundles the Ink sidecar into BUILD_DIR.
  // Pass it to fossilize as a SEA asset so it's available at runtime
  // via node:sea.getAsset(INK_SIDECAR_ASSET_KEY).
  const INK_SIDECAR = `${BUILD_DIR}/ink-app.js`;
  if (existsSync(INK_SIDECAR)) {
    assetArgs.push("--assets", INK_SIDECAR);
  }

  // Embed the DIF parser WASM (from @sentry/symbolic) as a SEA asset. The
  // runtime loads it via node:sea.getRawAsset(DIF_WASM_ASSET_KEY) — the asset
  // key MUST equal this path string (see src/lib/dif/index.ts).
  //
  // Resolve via Node module resolution rather than a hardcoded
  // node_modules path: in the pnpm workspace @sentry/symbolic may live in the
  // isolated store (linked under this package's node_modules) rather than at a
  // fixed literal path, so module resolution is the reliable way to find it.
  let DIF_WASM_SRC: string;
  try {
    DIF_WASM_SRC = createRequire(import.meta.url).resolve(
      "@sentry/symbolic/symbolic_bg.wasm",
    );
  } catch {
    throw new Error(
      "Missing @sentry/symbolic WASM (@sentry/symbolic/symbolic_bg.wasm). Run: pnpm install",
    );
  }
  if (!existsSync(DIF_WASM_SRC)) {
    throw new Error(
      `Missing @sentry/symbolic WASM at ${DIF_WASM_SRC}. Run: pnpm install`,
    );
  }
  const DIF_WASM = `${BUILD_DIR}/symbolic_bg.wasm`;
  copyFileSync(DIF_WASM_SRC, DIF_WASM);
  assetArgs.push("--assets", DIF_WASM);

  // Embed the Spleen dashboard glyph subset. The asset key matches the path
  // requested through node:sea in src/lib/formatters/spleen-font.ts.
  const SPLEEN_FONT_SRC = "src/lib/formatters/assets/spleen-8x16.bin";
  if (!existsSync(SPLEEN_FONT_SRC)) {
    throw new Error(
      `Missing Spleen dashboard font asset at ${SPLEEN_FONT_SRC}`,
    );
  }
  const SPLEEN_FONT = `${BUILD_DIR}/spleen-8x16.bin`;
  copyFileSync(SPLEEN_FONT_SRC, SPLEEN_FONT);
  assetArgs.push("--assets", SPLEEN_FONT);

  if (
    targets.some((target) => target.os === "darwin" && target.arch === "arm64")
  ) {
    // Always build and embed the decoder for darwin-arm64. Its asset path must
    // match CAR_EXTRACT_ASSET_KEY in src/lib/build/asset-catalog-extract.ts.
    const CAR_EXTRACT = `${BUILD_DIR}/car-extract`;
    copyFileSync(buildCarExtract(), CAR_EXTRACT);
    assetArgs.push("--assets", CAR_EXTRACT);
  }

  console.log(
    `  Step 2: Compiling ${platforms.length} target(s) (Node SEA via fossilize)...`,
  );

  // Invoke fossilize via `pnpm exec` so it resolves from the workspace bin
  // regardless of where pnpm places it (isolated store vs. root), rather than
  // assuming a fixed node_modules/.bin location.
  const fossilizeBin = "pnpm exec fossilize";

  try {
    execSync(
      [
        fossilizeBin,
        "--no-bundle",
        "--hole-punch",
        // Make the binary ignore NODE_OPTIONS so user V8 flags (e.g.
        // `NODE_OPTIONS=--max-old-space-size=8192`) don't change V8's
        // flag-hash and reject the code caches ("Code cache data
        // rejected"), the embedded one and the ones `src/lib/chunk-loader.ts`
        // writes. process.env is untouched, so child processes still
        // inherit the user's NODE_OPTIONS.
        "--ignore-node-options",
        "--output-name",
        "sentry",
        "--platforms",
        platforms.join(","),
        "--out-dir",
        "dist-bin",
        "--node-version",
        NODE_VERSION,
        ...assetArgs,
        SEA_MAIN_JS,
      ].join(" "),
      { stdio: "inherit" },
    );
  } catch (error) {
    console.error("  Fossilize compilation failed:");
    console.error(
      `    ${error instanceof Error ? error.message : String(error)}`,
    );
    return { successes: 0, failures: targets.length };
  }

  // Post-process each target: rename Windows binary, gzip
  let successes = 0;
  let failures = 0;
  for (const target of targets) {
    try {
      await postProcessTarget(target);
      successes += 1;
    } catch (error) {
      console.error(
        `  Post-processing ${getPackageName(target)} failed: ${String(error)}`,
      );
      failures += 1;
    }
  }
  return { successes, failures };
}

/**
 * Post-process a single compiled binary: rename from fossilize's output
 * naming to our expected naming, and optionally gzip.
 *
 * Fossilize outputs `sentry-{os}-{arch}[.exe]` where os is "win" for Windows.
 * We rename "win" → "windows" to match our release naming convention.
 *
 * Note: ICU hole-punch now runs inside fossilize (--hole-punch flag) before
 * code signing, so it's no longer done here.
 */
async function postProcessTarget(target: BuildTarget): Promise<void> {
  const packageName = getPackageName(target);
  const extension = target.os === "win32" ? ".exe" : "";
  const outfile = `dist-bin/${packageName}${extension}`;

  // Fossilize uses "win" not "windows" — rename if needed
  const fossilizeName = `dist-bin/sentry-${getFossilizePlatform(target)}${extension}`;
  if (fossilizeName !== outfile && existsSync(fossilizeName)) {
    renameSync(fossilizeName, outfile);
  }

  if (!existsSync(outfile)) {
    throw new Error(`Expected output not found: ${outfile}`);
  }

  console.log(`    -> ${outfile}`);

  // On main and release branches (RELEASE_BUILD=1), create gzip-compressed
  // copies for release downloads / GHCR nightly (~70% smaller with hole-punch).
  if (process.env.RELEASE_BUILD) {
    const binary = await readFile(outfile);
    const compressed = await gzipAsync(Buffer.from(binary), { level: 6 });
    await writeFile(`${outfile}.gz`, compressed);
    const ratio = (
      (1 - compressed.byteLength / binary.byteLength) *
      100
    ).toFixed(0);
    console.log(`    -> ${outfile}.gz (${ratio}% smaller)`);
  }
}

/** Parse target string (e.g., "darwin-x64", "linux-arm64") into BuildTarget */
function parseTarget(targetStr: string): BuildTarget | null {
  // Handle "windows" alias for "win32"
  const normalized = targetStr.replace("windows-", "win32-");
  const parts = normalized.split("-");
  const os = parts[0] as BuildTarget["os"];
  const arch = parts[1] as BuildTarget["arch"];

  const target = ALL_TARGETS.find((t) => t.os === os && t.arch === arch);
  return target ?? null;
}

/** Main build function */
async function build(): Promise<void> {
  const args = process.argv.slice(2);
  const singleBuild = args.includes("--single");
  const targetIndex = args.indexOf("--target");
  const targetArg = targetIndex !== -1 ? args[targetIndex + 1] : null;

  console.log(`\nSentry CLI Build v${VERSION}`);
  console.log("=".repeat(40));

  // Determine targets
  let targets: BuildTarget[];

  if (targetArg) {
    // Explicit target specified (for cross-compilation)
    const target = parseTarget(targetArg);
    if (!target) {
      console.error(`Invalid target: ${targetArg}`);
      console.error(
        `Valid targets: ${ALL_TARGETS.map((t) => `${t.os === "win32" ? "windows" : t.os}-${t.arch}`).join(", ")}`,
      );
      process.exit(1);
    }
    targets = [target];
    console.log(`\nBuilding for target: ${getPackageName(target)}`);
  } else if (singleBuild) {
    const currentTarget = ALL_TARGETS.find(
      (t) => t.os === process.platform && t.arch === process.arch,
    );
    if (!currentTarget) {
      console.error(
        `Unsupported platform: ${process.platform}-${process.arch}`,
      );
      process.exit(1);
    }
    targets = [currentTarget];
    console.log(
      `\nBuilding for current platform: ${getPackageName(currentTarget)}`,
    );
  } else {
    targets = ALL_TARGETS;
    console.log(`\nBuilding for ${targets.length} targets`);
  }

  // Clean and recreate output directory (esbuild requires it to exist).
  // Chunk names hash their content, so the last build's would stay around.
  await rm("dist-bin", { recursive: true, force: true });
  await rm(BUILD_DIR, { recursive: true, force: true });
  mkdirSync("dist-bin", { recursive: true });

  console.log("");

  // Step 1: Bundle TS → JS + sourcemaps (shared by all targets)
  const bundle = await bundleJs();
  if (!bundle) {
    process.exit(1);
  }

  // Inject debug IDs into the chunks and sourcemaps (non-fatal on failure).
  console.log("  Injecting debug IDs...");
  const injected = await injectDebugIds(bundle.files);
  console.log(`    -> Debug IDs injected into ${injected.length} files`);

  if (!(await bundleSeaMain(bundle))) {
    process.exit(1);
  }

  console.log("");

  // Step 2: Compile JS → native SEA binary for all targets at once
  const { successes: successCount, failures: failCount } =
    await compileAllTargets(targets, bundle);

  // Step 3: Upload the sourcemaps to Sentry (after compilation)
  await uploadSourcemapsToSentry(injected);

  // Clean up intermediate build directory (only the binaries are artifacts).
  // await rm(BUILD_DIR, { recursive: true, force: true });

  // Summary
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Build complete: ${successCount} succeeded, ${failCount} failed`);

  if (failCount > 0) {
    process.exit(1);
  }
}

await build();
