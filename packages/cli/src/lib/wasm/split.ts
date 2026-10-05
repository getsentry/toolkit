/**
 * Splitting a WebAssembly module into a deployable binary and a debug
 * companion.
 *
 * This is a direct port of Symbolicator's Rust `wasm-split`, and the ordering
 * of the steps is part of the contract rather than an implementation detail.
 * See {@link splitWasm} for what that ordering buys.
 *
 * Parity covers which modules are refused as well as what happens to the ones
 * that are accepted. Parsing is the gate, and it is calibrated against `wasmbin`
 * rather than against a full validator; see `binary.ts` for how deep that goes.
 *
 * The function is pure: it takes bytes and returns bytes. Reading and writing
 * files, resolving paths, and reporting to the user all belong to the caller,
 * which is what lets the `wasm-split` command and the debug-file pipeline share
 * it without sharing anything else.
 */

import {
  encodeModule,
  isDebugSection,
  isNameSection,
  makeBuildIdSection,
  makeExternalDebugInfoSection,
  parseSections,
  type WasmSection,
} from "./binary.js";
import { buildIdFromSections, randomBuildId } from "./build-id.js";

/** How to split a module. Every field is optional; the default is a no-op. */
export type SplitWasmOptions = {
  /**
   * Build id to stamp when the module carries none. Defaults to a random v4
   * UUID. Ignored when the module already has an id, which always wins.
   */
  buildId?: Uint8Array;
  /**
   * Produce a debug companion. The companion is a complete copy of the module,
   * so this costs roughly the size of the input.
   */
  companion?: boolean;
  /** Drop the `.debug_*` custom sections from the deployable module. */
  strip?: boolean;
  /**
   * Also drop the `name` section. Takes effect only alongside {@link strip},
   * mirroring the Rust control flow, where the strip predicate is reached only
   * inside the `--strip` branch.
   */
  stripNames?: boolean;
  /**
   * Where a browser can fetch the debug companion, written to the module as an
   * `external_debug_info` section. Already resolved: a bare filename is stored
   * as given, and Emscripten reads it relative to the module.
   */
  externalDebugInfo?: string;
};

/** The outcome of a split. */
export type SplitWasmResult = {
  /** The module's effective build id, existing or freshly minted. */
  buildId: Uint8Array;
  /** The deployable module, re-encoded. */
  module: Uint8Array;
  /**
   * Whether the deployable module differs from the input. When `false`, the
   * caller should skip the write: the bytes are identical, and not touching the
   * file keeps timestamps and build caches intact.
   */
  moduleChanged: boolean;
  /** The debug companion, present only when {@link SplitWasmOptions.companion}. */
  companion?: Uint8Array;
};

/**
 * Split a module.
 *
 * The steps run in a fixed order, and two of them matter:
 *
 * The build id is settled first, so both outputs carry the same one. That is
 * the whole point of the id — it is what pairs a stack frame with its debug
 * file.
 *
 * The companion is captured second, before any stripping. It is therefore a
 * complete copy, code section included. DWARF offsets are relative to the code
 * section, so a companion without it cannot be symbolicated, however much
 * `.debug_*` data it holds.
 *
 * Nothing is built until the input has been parsed in full, so a module the Rust
 * tool would refuse costs the caller an error and no output.
 *
 * @param bytes - A complete WebAssembly module
 * @param options - How to split it
 * @returns The effective build id, the deployable module, and the companion
 * @throws {import("./binary.js").WasmParseError} when `bytes` is not a module the
 *   Rust `wasm-split` would accept
 */
export function splitWasm(
  bytes: Uint8Array,
  options: SplitWasmOptions = {}
): SplitWasmResult {
  let sections = parseSections(bytes);
  let moduleChanged = false;

  // An id the module already carries wins: rewriting it would orphan debug
  // files uploaded against the old one.
  let buildId = buildIdFromSections(sections);
  if (buildId === null) {
    buildId = options.buildId ?? randomBuildId();
    sections = [...sections, makeBuildIdSection(buildId)];
    moduleChanged = true;
  }

  // Before stripping, so the companion keeps every section.
  const companion = options.companion ? encodeModule(sections) : undefined;

  if (options.strip) {
    const stripNames = options.stripNames ?? false;
    const kept = sections.filter(
      (section) => !isStrippable(section, stripNames)
    );
    if (kept.length !== sections.length) {
      sections = kept;
      moduleChanged = true;
    }
  }

  if (options.externalDebugInfo) {
    sections = [
      ...sections,
      makeExternalDebugInfoSection(options.externalDebugInfo),
    ];
    moduleChanged = true;
  }

  return {
    buildId,
    module: encodeModule(sections),
    moduleChanged,
    ...(companion ? { companion } : {}),
  };
}

/** Whether `--strip` should drop this section. */
function isStrippable(section: WasmSection, stripNames: boolean): boolean {
  return isNameSection(section) ? stripNames : isDebugSection(section);
}
