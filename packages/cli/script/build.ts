#!/usr/bin/env tsx

/**
 * Build script for Sentry CLI
 *
 * Creates standalone executables for multiple platforms using Node SEA
 * binaries via fossilize.
 * Binaries are uploaded to GitHub Releases.
 *
 * Uses a two-step build to produce external sourcemaps for Sentry:
 * 1. Bundle TS → single minified JS + external .map (esbuild)
 * 2. Compile JS → native SEA binary per platform (fossilize)
 * 3. Upload .map to Sentry for server-side stack trace resolution
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
 *     bin.js.map          (sourcemap, uploaded to Sentry then deleted)
 */

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { build as esbuild } from "esbuild";
import { uploadSourcemaps } from "../src/lib/api/sourcemaps.js";
import { injectDebugId, PLACEHOLDER_DEBUG_ID } from "./debug-id.js";
import { textImportPlugin } from "./text-import-plugin.js";

const gzipAsync = promisify(gzip);

const pkg = JSON.parse(await readFile("package.json", "utf-8"));
const VERSION: string = pkg.version;

/** Pin to Node 22 LTS for SEA binaries */
/** Node version for SEA binaries. "lts" resolves to the latest LTS via fossilize. */
const NODE_VERSION = "lts";

/** Files that use _require() for lazy relative imports (circular dep breaking). */
const REQUIRE_ALIAS_FILTER =
  /(?:db[\\/](?:index|schema)|list-command|telemetry)\.ts$/;
const REQUIRE_ALIAS_RE = /\b_require\(/g;

/** Build-time constants injected into the binary */
const SENTRY_CLIENT_ID = process.env.SENTRY_CLIENT_ID ?? "";

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

/** Path to the pre-bundled JS used by Step 2 (compile). */
const BUNDLE_JS = `${BUILD_DIR}/bin.js`;

/** Path to the sourcemap produced by Step 1 (bundle). */
const SOURCEMAP_FILE = `${BUILD_DIR}/bin.js.map`;

/**
 * Step 1: Bundle TypeScript sources into a single minified JS file
 * with an external sourcemap using esbuild.
 *
 * Uses esbuild instead of Bun's bundler to avoid Bun's identifier
 * minification bug (oven-sh/bun#14585 — name collisions in minified
 * output). esbuild's minifier is more mature and produces correct
 * identifier mangling plus rich sourcemaps (27k+ names vs Bun's
 * empty names array).
 *
 * This runs once and is shared by all compile targets. The sourcemap
 * is uploaded to Sentry (never shipped to users) for server-side
 * stack trace resolution.
 */
async function bundleJs(): Promise<boolean> {
  console.log("  Step 1: Bundling TypeScript → JS + sourcemap...");

  try {
    const result = await esbuild({
      entryPoints: ["./src/bin.ts"],
      bundle: true,
      outfile: BUNDLE_JS,
      platform: "node",
      // Target Node 24 LTS. Downlevels `using` declarations (not
      // supported in CJS). Node SEA runs embedded JS as CJS.
      target: "node24",
      format: "cjs",
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
      sourcemap: "linked",
      minify: true,
      metafile: true,
      // CJS format needs import.meta.url shimmed via inject + define.
      inject: ["./script/import-meta-url.js"],
      define: {
        "import.meta.url": "import_meta_url",
        SENTRY_CLI_VERSION: JSON.stringify(VERSION),
        SENTRY_CLIENT_ID_BUILD: JSON.stringify(SENTRY_CLIENT_ID),
        "process.env.NODE_ENV": JSON.stringify("production"),
        __SENTRY_DEBUG_ID__: JSON.stringify(PLACEHOLDER_DEBUG_ID),
      },
      plugins: [
        textImportPlugin,
        // Transform _require() → require() so esbuild resolves lazy relative
        // requires at bundle time. In tsx dev mode, _require is a file-local
        // createRequire(import.meta.url) that resolves relative to the file.
        // esbuild only statically resolves bare require() calls.
        // Only targets the specific files that use _require with relative paths.
        {
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
        },
      ],
    });

    const output = result.metafile?.outputs[BUNDLE_JS];
    const jsSize = (
      (output?.bytes ?? (await stat(BUNDLE_JS)).size) /
      1024 /
      1024
    ).toFixed(2);
    const mapSize = ((await stat(SOURCEMAP_FILE)).size / 1024 / 1024).toFixed(
      2
    );
    console.log(`    -> ${BUNDLE_JS} (${jsSize} MB)`);
    console.log(`    -> ${SOURCEMAP_FILE} (${mapSize} MB, for Sentry upload)`);
    return true;
  } catch (error) {
    console.error("  Failed to bundle JS:");
    console.error(
      `    ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Inject debug IDs and upload sourcemap to Sentry.
 *
 * Both injection and upload are done natively — no external binary needed.
 * Uses the chunk-upload + assemble protocol for reliable artifact delivery.
 *
 * Requires SENTRY_AUTH_TOKEN environment variable for upload. Debug ID
 * injection always runs (even without auth token) so local builds get
 * debug IDs for development/testing.
 */
/** Module-level debug ID set by {@link injectDebugIds} for use in {@link uploadSourcemapToSentry}. */
let currentDebugId: string | undefined;

/**
 * Inject debug IDs into the JS and sourcemap. Runs before compilation.
 * The upload happens separately after compilation (see {@link uploadSourcemapToSentry}).
 */
async function injectDebugIds(): Promise<void> {
  // skipSnippet: true — the IIFE snippet breaks ESM (placed before import
  // declarations). The debug ID is instead registered in constants.ts via
  // a build-time __SENTRY_DEBUG_ID__ constant.
  console.log("  Injecting debug IDs...");
  try {
    const { debugId } = await injectDebugId(BUNDLE_JS, SOURCEMAP_FILE, {
      skipSnippet: true,
    });
    currentDebugId = debugId;
    console.log(`    -> Debug ID: ${debugId}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`    Warning: Debug ID injection failed: ${msg}`);
    return;
  }

  // Replace the placeholder UUID with the real debug ID in the JS bundle.
  // Both are 36-char UUIDs so sourcemap character positions stay valid.
  try {
    const jsContent = await readFile(BUNDLE_JS, "utf-8");
    await writeFile(
      BUNDLE_JS,
      jsContent.split(PLACEHOLDER_DEBUG_ID).join(currentDebugId)
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(
      `    Warning: Debug ID placeholder replacement failed: ${msg}`
    );
  }
}

/**
 * Upload the sourcemap to Sentry. Runs after compilation.
 */
async function uploadSourcemapToSentry(): Promise<void> {
  const debugId = currentDebugId;
  if (!debugId) {
    return;
  }

  if (!process.env.SENTRY_AUTH_TOKEN) {
    console.log("  No SENTRY_AUTH_TOKEN, skipping sourcemap upload");
    return;
  }

  console.log(`  Uploading sourcemap to Sentry (release: ${VERSION})...`);

  try {
    const dir = BUNDLE_JS.slice(0, BUNDLE_JS.lastIndexOf("/") + 1);
    const urlPrefix = `~/${dir}`;
    const jsBasename = BUNDLE_JS.split("/").pop() ?? "bin.js";
    const mapBasename = SOURCEMAP_FILE.split("/").pop() ?? "bin.js.map";

    await uploadSourcemaps({
      org: "sentry",
      project: "cli",
      release: VERSION,
      files: [
        {
          path: BUNDLE_JS,
          debugId,
          type: "minified_source",
          url: `${urlPrefix}${jsBasename}`,
          sourcemapFilename: mapBasename,
        },
        {
          path: SOURCEMAP_FILE,
          debugId,
          type: "source_map",
          url: `${urlPrefix}${mapBasename}`,
        },
      ],
    });
    console.log("    -> Sourcemap uploaded to Sentry");
  } catch (error) {
    // Non-fatal: don't fail the build if upload fails
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`    Warning: Sourcemap upload failed: ${msg}`);
  }
}

/**
 * Step 2: Compile the pre-bundled JS into Node SEA binaries for all targets
 * using fossilize. Runs a single fossilize invocation for all platforms
 * (fossilize parallelizes internally), then post-processes each binary.
 */
async function compileAllTargets(
  targets: BuildTarget[]
): Promise<{ successes: number; failures: number }> {
  const platforms = targets.map((t) => getFossilizePlatform(t));

  // Add ink sidecar as asset if it exists (pre-bundled by text-import-plugin)
  const assetArgs: string[] = [];
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
      "@sentry/symbolic/symbolic_bg.wasm"
    );
  } catch {
    throw new Error(
      "Missing @sentry/symbolic WASM (@sentry/symbolic/symbolic_bg.wasm). Run: pnpm install"
    );
  }
  if (!existsSync(DIF_WASM_SRC)) {
    throw new Error(
      `Missing @sentry/symbolic WASM at ${DIF_WASM_SRC}. Run: pnpm install`
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
      `Missing Spleen dashboard font asset at ${SPLEEN_FONT_SRC}`
    );
  }
  const SPLEEN_FONT = `${BUILD_DIR}/spleen-8x16.bin`;
  copyFileSync(SPLEEN_FONT_SRC, SPLEEN_FONT);
  assetArgs.push("--assets", SPLEEN_FONT);

  console.log(
    `  Step 2: Compiling ${platforms.length} target(s) (Node SEA via fossilize)...`
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
        // flag-hash and reject the embedded code cache ("Code cache data
        // rejected"). process.env is untouched, so child processes still
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
        BUNDLE_JS,
      ].join(" "),
      { stdio: "inherit" }
    );
  } catch (error) {
    console.error("  Fossilize compilation failed:");
    console.error(
      `    ${error instanceof Error ? error.message : String(error)}`
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
        `  Post-processing ${getPackageName(target)} failed: ${error}`
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

  if (!SENTRY_CLIENT_ID) {
    console.error(
      "\nError: SENTRY_CLIENT_ID environment variable is required."
    );
    console.error("   The CLI requires OAuth to function.");
    console.error("   Set it via: SENTRY_CLIENT_ID=xxx pnpm run build\n");
    process.exit(1);
  }

  // Determine targets
  let targets: BuildTarget[];

  if (targetArg) {
    // Explicit target specified (for cross-compilation)
    const target = parseTarget(targetArg);
    if (!target) {
      console.error(`Invalid target: ${targetArg}`);
      console.error(
        `Valid targets: ${ALL_TARGETS.map((t) => `${t.os === "win32" ? "windows" : t.os}-${t.arch}`).join(", ")}`
      );
      process.exit(1);
    }
    targets = [target];
    console.log(`\nBuilding for target: ${getPackageName(target)}`);
  } else if (singleBuild) {
    const currentTarget = ALL_TARGETS.find(
      (t) => t.os === process.platform && t.arch === process.arch
    );
    if (!currentTarget) {
      console.error(
        `Unsupported platform: ${process.platform}-${process.arch}`
      );
      process.exit(1);
    }
    targets = [currentTarget];
    console.log(
      `\nBuilding for current platform: ${getPackageName(currentTarget)}`
    );
  } else {
    targets = ALL_TARGETS;
    console.log(`\nBuilding for ${targets.length} targets`);
  }

  // Clean and recreate output directory (esbuild requires it to exist)
  await rm("dist-bin", { recursive: true, force: true });
  mkdirSync("dist-bin", { recursive: true });

  console.log("");

  // Step 1: Bundle TS → JS + sourcemap (shared by all targets)
  const bundled = await bundleJs();
  if (!bundled) {
    process.exit(1);
  }

  // Inject debug IDs into the JS and sourcemap (non-fatal on failure).
  await injectDebugIds();

  console.log("");

  // Step 2: Compile JS → native SEA binary for all targets at once
  const { successes: successCount, failures: failCount } =
    await compileAllTargets(targets);

  // Step 3: Upload the sourcemap to Sentry (after compilation)
  await uploadSourcemapToSentry();

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
