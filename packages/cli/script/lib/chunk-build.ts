/**
 * Steps after `buildSplitBundle()` (`./split-bundle.ts`) that the npm package
 * (`script/bundle.ts`) and the standalone binary (`script/build.ts`) share:
 * debug IDs and sourcemap upload for every chunk, and the CLI's main script
 * (`src/chunk-main.ts`), which runs the chunks with a code cache.
 */

import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { basename } from "node:path";
import { build } from "esbuild";
import { uploadSourcemaps } from "../../src/lib/api/sourcemaps.js";
import type { MainChunkBuild } from "../../src/chunk-main.js";
import { injectDebugId } from "../debug-id.js";
import { logger } from "../../src/lib/logger.js";

/** A JavaScript file with a debug ID, and its sourcemap. */
export type InjectedFile = {
  readonly jsPath: string;
  readonly mapPath: string;
  readonly debugId: string;
};

/**
 * Inject a debug ID into each file of `jsFiles` and its `.map`. Each file
 * registers its own ID at runtime with the snippet `injectDebugId` adds, so
 * stack frames of every chunk resolve. A failure only warns: the build still
 * works, its stack traces just don't resolve.
 */
export async function injectDebugIds(
  jsFiles: readonly string[],
): Promise<InjectedFile[]> {
  const injected = await Promise.all(
    jsFiles.map(async (jsPath): Promise<InjectedFile | undefined> => {
      const mapPath = `${jsPath}.map`;
      try {
        const { debugId } = await injectDebugId(jsPath, mapPath);
        return { jsPath, mapPath, debugId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`Debug ID injection failed for ${jsPath}: ${msg}`);
        return;
      }
    }),
  );
  return injected.filter((file) => file !== undefined);
}

/**
 * Upload the sourcemaps of `injected` to the `sentry/cli` project. A chunk's
 * URL is `urlPrefix` and its file name: the filename its stack frames have.
 *
 * @returns Whether the upload succeeded. A failure only warns.
 */
export async function uploadChunkSourcemaps(
  injected: readonly InjectedFile[],
  options: { readonly release: string; readonly urlPrefix: string },
): Promise<boolean> {
  try {
    logger.start(`Uploading ${injected.length} sourcemaps to Sentry...`);
    await uploadSourcemaps({
      org: "sentry",
      project: "cli",
      release: options.release,
      files: injected.flatMap(({ jsPath, mapPath, debugId }) => [
        {
          path: jsPath,
          debugId,
          type: "minified_source" as const,
          url: `${options.urlPrefix}${basename(jsPath)}`,
          sourcemapFilename: basename(mapPath),
        },
        {
          path: mapPath,
          debugId,
          type: "source_map" as const,
          url: `${options.urlPrefix}${basename(mapPath)}`,
        },
      ]),
    });
    logger.success("Sourcemaps uploaded to Sentry");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Sourcemap upload failed: ${msg}`);
    return false;
  }
}

/** Delete the sourcemaps of `injected`, which don't ship to users. */
export async function deleteSourcemaps(
  injected: readonly InjectedFile[],
): Promise<void> {
  await Promise.all(
    injected.map(({ mapPath }) => unlink(mapPath).catch(() => undefined)),
  );
}

/**
 * Describe the chunks in `files`. Their ID hashes their final content, so
 * call it after debug ID injection.
 */
export async function chunkBuild(
  files: readonly string[],
  entries: MainChunkBuild["entries"],
): Promise<MainChunkBuild> {
  const sorted = [...files].sort();
  const hash = createHash("sha256");
  for (const file of sorted) {
    hash
      .update(basename(file))
      .update("\0")
      .update(await readFile(file));
  }
  return {
    id: hash.digest("hex").slice(0, 16),
    chunks: sorted.map((file) => basename(file)),
    entries,
  };
}

/** What {@link buildMainScript} builds. */
export type MainScriptOptions = {
  readonly outfile: string;
  /** The chunks the main script runs, from {@link chunkBuild}. */
  readonly chunks: MainChunkBuild;
  /**
   * Key prefix of the chunks' SEA assets (`dist-build`). Without it, the
   * chunks are files next to the main script.
   */
  readonly assetDir?: string;
  readonly target: string;
  readonly banner?: string;
};

/** Bundle the CLI's main script, `src/chunk-main.ts`. */
export async function buildMainScript(
  options: MainScriptOptions,
): Promise<void> {
  await build({
    entryPoints: ["./src/chunk-main.ts"],
    bundle: true,
    minify: true,
    platform: "node",
    target: options.target,
    format: "cjs",
    outfile: options.outfile,
    banner: options.banner ? { js: options.banner } : undefined,
    define: {
      CHUNK_BUILD: JSON.stringify(options.chunks),
      CHUNK_ASSET_DIR:
        options.assetDir === undefined
          ? "undefined"
          : JSON.stringify(options.assetDir),
    },
  });
}
