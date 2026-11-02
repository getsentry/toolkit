/**
 * Main script of the standalone binary.
 *
 * The CLI (`bin.ts`) and the shell-completion engine (`complete-bin.ts`) are
 * embedded as separate SEA assets. This bootstrap picks one and runs it, so
 * `sentry __complete` never compiles the 7 MB CLI bundle. Each chunk keeps a
 * V8 code cache under the config directory (see `lib/sea-chunk.ts`).
 *
 * Built by `script/build.ts`, which defines `SEA_CHUNKS`. Imports only
 * `node:` builtins and pure helpers: it runs before every command.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { getAsset } from "node:sea";
import { resolveConfigDir } from "./lib/config-dir.js";
import {
  reportCodeCacheError,
  runSeaChunk,
  type SeaChunk,
} from "./lib/sea-chunk.js";

/** An embedded chunk: its SEA asset key and the hash of its source. */
type ChunkAsset = { asset: string; buildId: string };

declare const SEA_CHUNKS: { cli: ChunkAsset; complete: ChunkAsset };

/** Where chunks keep their code cache, or `undefined` without a home directory. */
function codeCacheDir(): string | undefined {
  try {
    return join(resolveConfigDir(process.env, homedir()), "cache", "code");
  } catch (error) {
    reportCodeCacheError("No config directory", error);
    return;
  }
}

// `bin.ts` runs the React Native Xcode wrapper (`__SENTRY_RN_WRAP_XCODE_CALL`)
// before it looks at the arguments, so only the CLI chunk may handle it.
const name =
  process.argv[2] === "__complete" &&
  process.env.__SENTRY_RN_WRAP_XCODE_CALL !== "1"
    ? "complete"
    : "cli";
const { asset, buildId } = SEA_CHUNKS[name];
const chunk: SeaChunk = {
  name,
  buildId,
  source: getAsset(asset, "utf8"),
  // The path the main script had before the split, which the uploaded
  // sourcemap's URL matches.
  filename: asset,
};

runSeaChunk(
  chunk,
  { exports, require, module, filename: __filename, dirname: __dirname },
  codeCacheDir(),
);
