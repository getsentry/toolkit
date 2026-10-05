/**
 * sentry wasm-split <input>
 *
 * Add a build id to a WebAssembly module, and optionally split its debug data
 * into a companion file.
 *
 * A drop-in replacement for Symbolicator's Rust `wasm-split` binary: same
 * flags, same behaviour, and the same stdout contract of a single lowercase hex
 * build id, so `BUILD_ID=$(sentry wasm-split app.wasm)` keeps working for
 * anyone moving off the Rust tool.
 *
 * "Drop-in" is meant to cover which files are rejected too, not just what the
 * accepted ones turn into. The same modules go through and the same ones fail,
 * because the parser is calibrated against the Rust tool's own; see
 * `lib/wasm/binary.ts`.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { SentryContext } from "../context.js";
import { buildCommand } from "../lib/command.js";
import { ValidationError } from "../lib/errors.js";
import { CommandOutput } from "../lib/formatters/output.js";
import { formatBuildId, uuidToBytes } from "../lib/wasm/build-id.js";
import { splitWasm } from "../lib/wasm/split.js";

/** Flags accepted by `sentry wasm-split`. */
type WasmSplitFlags = {
  out?: string;
  "debug-out"?: string;
  strip: boolean;
  "strip-names": boolean;
  quiet: boolean;
  json?: boolean;
  "build-id"?: string;
  "external-dwarf-url"?: string;
};

/** Structured result for the wasm-split command. */
type WasmSplitResult = {
  /** The module's build id, as lowercase hex. */
  buildId: string;
  /** Path of the module that was read. */
  input: string;
  /** Where the deployable module was written, absent when nothing changed. */
  output?: string;
  /** Where the debug companion was written, absent unless one was requested. */
  debugOutput?: string;
};

export const wasmSplitCommand = buildCommand({
  docs: {
    brief: "Add build ids to WebAssembly modules and split out debug data",
    fullDescription:
      "Add a build id to a WebAssembly module and optionally split its debug " +
      "data into a companion file. Sentry matches a wasm stack frame to its " +
      "debug file by build id, so a module without one can never be " +
      "symbolicated.\n\n" +
      "An id the module already carries is reused; otherwise one is minted " +
      "and written into the module. The build id is printed to stdout as " +
      "lowercase hex and nothing else, so it can be captured in a shell " +
      "variable.\n\n" +
      "The debug companion is a complete copy of the module, captured before " +
      "stripping. DWARF offsets are relative to the code section, so a " +
      "companion missing it cannot be symbolicated.\n\n" +
      "This is a drop-in replacement for Symbolicator's `wasm-split` binary.\n\n" +
      "Usage:\n" +
      "  sentry wasm-split app.wasm\n" +
      "  sentry wasm-split app.wasm -d app.debug.wasm --strip\n" +
      "  BUILD_ID=$(sentry wasm-split app.wasm)",
  },
  // Purely local file operation — no Sentry API calls, no auth needed.
  auth: false,
  output: {
    // Print only the bare build id, matching the Rust binary's stdout.
    human: (data: WasmSplitResult) => data.buildId,
    jsonExclude: [],
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Path to the wasm file",
          parse: String,
          placeholder: "input",
        },
      ],
    },
    flags: {
      out: {
        kind: "parsed",
        parse: String,
        brief: "Path to the output wasm file (default: modify input in place)",
        optional: true,
      },
      "debug-out": {
        kind: "parsed",
        parse: String,
        brief:
          "Path to the output debug wasm file (default: debug data stays in the input)",
        optional: true,
      },
      strip: {
        kind: "boolean",
        brief: "Strip the file of debug info",
        default: false,
        optional: true,
      },
      "strip-names": {
        kind: "boolean",
        brief: "Strip the file of symbol names (only with --strip)",
        default: false,
        optional: true,
      },
      quiet: {
        kind: "boolean",
        brief: "Do not print the build id",
        default: false,
        optional: true,
      },
      "build-id": {
        kind: "parsed",
        parse: String,
        brief: "Explicit build id to use, as a UUID",
        optional: true,
      },
      "external-dwarf-url": {
        kind: "parsed",
        parse: String,
        brief: "URL for browsers to fetch the separate DWARF debug symbol file",
        optional: true,
      },
    },
    aliases: {
      o: "out",
      d: "debug-out",
      q: "quiet",
    },
  },
  async *func(this: SentryContext, flags: WasmSplitFlags, input: string) {
    if (!input?.trim()) {
      throw new ValidationError(
        "Wasm file path is required: sentry wasm-split <input>",
        "input"
      );
    }

    if (flags.quiet && flags.json) {
      throw new ValidationError("--quiet cannot be used with --json.", "quiet");
    }

    const explicitBuildId = parseExplicitBuildId(flags["build-id"]);
    const debugOut = flags["debug-out"];

    const result = splitWasm(await readWasmModule(input), {
      ...(explicitBuildId ? { buildId: explicitBuildId } : {}),
      companion: debugOut !== undefined,
      strip: flags.strip,
      stripNames: flags["strip-names"],
      ...resolveExternalDebugInfo(flags["external-dwarf-url"], debugOut),
    });

    // Before the main module, so a failure here never leaves a stripped binary
    // with no companion to symbolicate it.
    if (debugOut !== undefined && result.companion) {
      await writeFile(debugOut, result.companion);
    }

    const output = flags.out ?? input;
    if (result.moduleChanged) {
      await writeFile(output, result.module);
    }

    if (flags.quiet) {
      return {};
    }

    yield new CommandOutput<WasmSplitResult>({
      buildId: formatBuildId(result.buildId),
      input,
      ...(result.moduleChanged ? { output } : {}),
      ...(debugOut !== undefined ? { debugOutput: debugOut } : {}),
    });
    return {};
  },
});

/** Validate `--build-id`, which the Rust binary parses as a UUID. */
function parseExplicitBuildId(value: string | undefined): Uint8Array | null {
  if (value === undefined) {
    return null;
  }
  const bytes = uuidToBytes(value);
  if (!bytes) {
    throw new ValidationError(
      `Invalid --build-id '${value}': expected a UUID.`,
      "build-id"
    );
  }
  return bytes;
}

/**
 * Resolve the value of the `external_debug_info` section.
 *
 * `--external-dwarf-url` wins; otherwise the basename of `--debug-out` is a
 * reasonable default, because a bare filename resolves relative to the main
 * wasm file. Emscripten falls back the same way.
 */
function resolveExternalDebugInfo(
  url: string | undefined,
  debugOut: string | undefined
): { externalDebugInfo?: string } {
  const resolved = url ?? (debugOut ? basename(debugOut) : undefined);
  return resolved ? { externalDebugInfo: resolved } : {};
}

/** Read a wasm module, turning the usual path mistakes into clear errors. */
async function readWasmModule(path: string): Promise<Uint8Array> {
  try {
    return await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ValidationError(`Wasm file '${path}' does not exist.`, "input");
    }
    if (code === "EISDIR") {
      throw new ValidationError(
        `Path '${path}' is a directory, not a wasm file.`,
        "input"
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      `Cannot read wasm file '${path}': ${msg}`,
      "input"
    );
  }
}
