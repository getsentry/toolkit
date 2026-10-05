/**
 * The `build_id` custom section of a WebAssembly module.
 *
 * Sentry matches a stack frame to its debug file by build id, so every module
 * that might appear in a stack trace needs one — and a module and its debug
 * companion must carry the same one. This module owns generating and reading
 * that id; deciding *which* modules to stamp belongs to the callers.
 *
 * The encoding follows the WebAssembly tool conventions, so ids written here
 * are interchangeable with those written by the Rust `wasm-split`.
 */

import { UUID, uuidv4obj } from "uuidv7";
import { BUILD_ID_SECTION, decodeBuildId, type WasmSection } from "./binary.js";

/**
 * Render build id bytes as lowercase hex.
 *
 * Used by `wasm-split` for stdout and `--json` output; accepts any length so
 * ids read from a module match the Rust tool's `hex::encode`, not only UUIDs.
 */
export function formatBuildId(buildId: Uint8Array): string {
  return Buffer.from(buildId).toString("hex");
}

/**
 * Parse a UUID string into its 16 raw bytes.
 *
 * Used by `wasm-split` for `--build-id`; returns `null` instead of throwing so
 * the command can raise a `ValidationError` rather than a `SyntaxError`.
 *
 * @param uuid - A UUID, with or without hyphens, in either case
 * @returns The bytes, or `null` when the string is not a UUID
 */
export function uuidToBytes(uuid: string): Uint8Array | null {
  // biome-ignore lint/plugin: a parse failure is the answer — the caller turns null into its own error
  try {
    return new Uint8Array(UUID.parse(uuid).bytes);
  } catch {
    return null;
  }
}

/**
 * Generate a random v4 build id.
 *
 * Used by `splitWasm` when the module carries no readable id and the caller
 * did not pass `--build-id`.
 */
export function randomBuildId(): Uint8Array {
  return new Uint8Array(uuidv4obj().bytes);
}

/**
 * Read the build id out of already-parsed sections.
 *
 * Used by `splitWasm` before minting or stamping; an existing id must be reused
 * so debug files already uploaded against it stay matched.
 *
 * The first readable `build_id` wins, and a malformed section is skipped rather
 * than treated as an answer — both matching the Rust tool, where a section that
 * fails to decode never reaches `find_map`. A module should carry at most one
 * id, but the distinction still matters: minting a fresh id for a module that
 * already has a good one would orphan every debug file uploaded against it.
 */
export function buildIdFromSections(
  sections: WasmSection[]
): Uint8Array | null {
  for (const section of sections) {
    if (section.name !== BUILD_ID_SECTION || !section.contents) {
      continue;
    }
    const buildId = decodeBuildId(section.contents);
    if (buildId) {
      return buildId;
    }
  }
  return null;
}
