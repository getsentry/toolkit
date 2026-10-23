/**
 * Writing a build id onto a module already on disk.
 *
 * Kept apart from `split.ts`, which stays a pure bytes-in/bytes-out port of the
 * Rust `wasm-split`. Everything here is the file-level layer above it, shared
 * by `debug-files wasm-upload` and the wasm sourcemap path so both stamp under the
 * same rule: an id already on the module always wins, and a dry run writes
 * nothing.
 */

import { writeFile } from "node:fs/promises";
import { type SplitWasmResult, splitWasm } from "./split.js";

/** How to stamp a module that carries no build id yet. */
export type StampOptions = {
  /** Id to use when one must be minted. Defaults to a random v4 UUID. */
  buildId?: Uint8Array;
  /** Report what would change without writing. */
  dryRun?: boolean;
};

/**
 * Stamp a module with a build id, changing nothing else.
 *
 * A split with neither `strip` nor `companion` is exactly that, so stamping
 * shares one implementation with the real split rather than reassembling the
 * section list by hand.
 *
 * @param bytes - The module as read from disk
 * @param buildId - Id to stamp when the module carries none
 * @returns The effective id and the re-encoded module
 */
export function stampBuildId(
  bytes: Uint8Array,
  buildId?: Uint8Array,
): SplitWasmResult {
  return splitWasm(bytes, buildId ? { buildId } : {});
}

/**
 * Give a module a build id, writing it back in place when it has none.
 *
 * `wasm-split` stamps every module it processes regardless of debug quality.
 * Sentry matches a stack frame to its debug file by build id, so an unstamped
 * module can never be symbolicated — not even from a debug file uploaded
 * later. Stamping now keeps that option open.
 *
 * @param path - Module to stamp
 * @param bytes - The module as read from disk
 * @param existing - Id the module already carries, if any
 * @param options - Which id to mint, and whether to write at all
 * @returns The effective build id, or `null` when a dry run left the module
 *   untouched
 */
export async function ensureBuildIdOnDisk(
  path: string,
  bytes: Uint8Array,
  existing: Uint8Array | null,
  options: StampOptions = {},
): Promise<Uint8Array | null> {
  // Checked before splitting so an already-stamped module is never re-encoded.
  if (existing) {
    return existing;
  }
  if (options.dryRun) {
    return null;
  }
  const stamped = stampBuildId(bytes, options.buildId);
  await writeFile(path, stamped.module);
  return stamped.buildId;
}
