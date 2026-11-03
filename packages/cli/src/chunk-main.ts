/**
 * Main script of the CLI: `dist/bin.cjs` in the npm package, and the SEA main
 * script of the standalone binary.
 *
 * Both ship the CLI as the same code-split CommonJS chunks (see
 * `script/lib/split-bundle.ts`). This picks the entry chunk, the CLI
 * (`bin.ts`) or the shell-completion engine (`complete-bin.ts`), and runs it
 * through `lib/chunk-loader.ts`, which loads the chunks it requires from the
 * files next to this script or from SEA assets, with a V8 code cache under
 * the config directory.
 *
 * Built by `script/bundle.ts` and `script/build.ts`, which define
 * `CHUNK_BUILD` and, for the binary, `CHUNK_ASSET_DIR`. Imports only `node:`
 * builtins and pure helpers: it runs before every command.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ChunkBuild,
  type ChunkSource,
  canLoadChunks,
  createChunkLoader,
  reportCodeCacheError,
} from "./lib/chunk-loader.js";
import { resolveConfigDir } from "./lib/config-dir.js";

/** The chunks of a build, and the entry chunk of each program. */
export type MainChunkBuild = ChunkBuild & {
  readonly entries: { readonly cli: string; readonly complete: string };
};

declare const CHUNK_BUILD: MainChunkBuild;

/**
 * Key prefix of the chunks' SEA assets in the standalone binary. Undefined
 * in the npm package, whose chunks are files next to this script.
 */
declare const CHUNK_ASSET_DIR: string | undefined;

/** Where chunks keep their code cache, or `undefined` without a home directory. */
function codeCacheDir(): string | undefined {
  try {
    return join(resolveConfigDir(process.env, homedir()), "cache", "code");
  } catch (error) {
    reportCodeCacheError("No config directory", error);
    return;
  }
}

/**
 * Chunks embedded as SEA assets. They run with the main script's
 * `__filename` and `__dirname`, and stack traces name the asset key, which
 * the uploaded sourcemap's URL matches.
 */
function assetSource(dir: string): ChunkSource {
  const { getAsset } = require("node:sea") as typeof import("node:sea");
  const scope = { filename: __filename, dirname: __dirname };
  return {
    read: (name) => getAsset(`${dir}/${name}`, "utf8"),
    filename: (name) => `${dir}/${name}`,
    scope: () => scope,
    require,
  };
}

/** Chunks in files next to this script. */
function fileSource(): ChunkSource {
  return {
    read: (name) => readFileSync(join(__dirname, name), "utf8"),
    filename: (name) => join(__dirname, name),
    scope: (name) => ({ filename: join(__dirname, name), dirname: __dirname }),
    require,
  };
}

// `bin.ts` runs the React Native Xcode wrapper (`__SENTRY_RN_WRAP_XCODE_CALL`)
// before it looks at the arguments, so only the CLI chunk may handle it.
const entry =
  CHUNK_BUILD.entries[
    process.argv[2] === "__complete" &&
    process.env.__SENTRY_RN_WRAP_XCODE_CALL !== "1"
      ? "complete"
      : "cli"
  ];

if (CHUNK_ASSET_DIR !== undefined) {
  createChunkLoader(
    CHUNK_BUILD,
    assetSource(CHUNK_ASSET_DIR),
    codeCacheDir(),
  )(entry);
} else if (canLoadChunks()) {
  createChunkLoader(CHUNK_BUILD, fileSource(), codeCacheDir())(entry);
} else {
  // Node < 22: let Node load the chunks, without a code cache
  require(join(__dirname, entry));
}
