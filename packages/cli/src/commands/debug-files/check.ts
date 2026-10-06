/**
 * sentry debug-files check <path>
 *
 * Inspect a debug information file (Mach-O/dSYM, ELF, PE/PDB, Portable PDB,
 * WASM, Breakpad, SourceBundle) and print its debug id, code id, architecture,
 * kind, and feature flags.
 *
 * Local-only — no API calls. Parsing is done in-process via the bundled
 * `symbolic` WASM module (see `src/lib/dif/`).
 *
 * Exits non-zero if the file is not usable for symbolication (no debug id or
 * no useful features), mirroring the legacy `sentry-cli difutil check`.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { type DifArchiveInfo, parseDebugFile } from "../../lib/dif/index.js";
import { ValidationError } from "../../lib/errors.js";
import {
  colorTag,
  mdKvTable,
  renderMarkdown,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { readDebugFile } from "./read-file.js";

const USAGE_HINT = "sentry debug-files check <path>";

/** Structured result for the check command. */
type DebugFilesCheckResult = DifArchiveInfo & {
  /** Path to the inspected file. */
  path: string;
  /** Whether the file is usable for symbolication (has ids + features). */
  usable: boolean;
};

/** Human-readable list of the enabled feature flags for an object. */
function featureList(o: DebugFilesCheckResult["objects"][number]): string {
  const features: string[] = [];
  if (o.hasSymbols) {
    features.push("symtab");
  }
  if (o.hasDebugInfo) {
    features.push("debug");
  }
  if (o.hasUnwindInfo) {
    features.push("unwind");
  }
  if (o.hasSources) {
    features.push("sources");
  }
  return features.length > 0 ? features.join(", ") : colorTag("muted", "none");
}

/** Format human-readable output for the check command. */
function formatCheckResult(data: DebugFilesCheckResult): string {
  const sections: string[] = [];

  for (const o of data.objects) {
    const rows: [string, string][] = [
      ["Debug ID", o.debugId],
      ["Code ID", o.codeId ?? colorTag("muted", "none")],
      ["Arch", o.arch],
      ["Format", o.fileFormat],
      ["Kind", o.kind],
      ["Features", featureList(o)],
    ];
    sections.push(renderMarkdown(mdKvTable(rows)));
  }

  let out = sections.join("\n");
  if (!data.usable) {
    out += `\n${renderMarkdown(
      colorTag(
        "warning",
        "This file is not usable for symbolication (missing debug id or features)."
      )
    )}`;
  }
  return out;
}

/**
 * Nil debug id (hyphenated UUID form). A debug id starting with this means the
 * object carries no real identifier. PE/PDB ids may append an `-<age>` suffix,
 * so we match on prefix.
 */
const NIL_DEBUG_ID_PREFIX = "00000000-0000-0000-0000-000000000000";

/** Whether an object carries a usable identifier (non-nil debug id or code id). */
function hasId(o: DifArchiveInfo["objects"][number]): boolean {
  const hasDebugId =
    o.debugId.length > 0 && !o.debugId.startsWith(NIL_DEBUG_ID_PREFIX);
  const hasCodeId = o.codeId !== null && o.codeId.length > 0;
  return hasDebugId || hasCodeId;
}

/** Whether an object carries any useful feature. */
function hasFeature(o: DifArchiveInfo["objects"][number]): boolean {
  return o.hasSymbols || o.hasDebugInfo || o.hasUnwindInfo || o.hasSources;
}

/**
 * Determine whether a parsed archive is usable for symbolication: at least one
 * object must have an identifier AND at least one useful feature. Mirrors the
 * legacy `difutil check` `is_usable()` semantics.
 */
function isUsable(archive: DifArchiveInfo): boolean {
  return archive.objects.some((o) => hasId(o) && hasFeature(o));
}

export const checkCommand = buildCommand({
  // Local-only: parses the file in-process, no API calls.
  auth: false,
  docs: {
    brief: "Inspect a debug information file",
    fullDescription:
      "Inspect a debug information file and print its debug id, code id, " +
      "architecture, kind, and feature flags. Supports Mach-O/dSYM, ELF, " +
      "PE/PDB, Portable PDB, WebAssembly, Breakpad, and source bundles.\n\n" +
      "The format is auto-detected. This command is local-only and makes no " +
      "network requests.\n\n" +
      "Usage:\n" +
      "  sentry debug-files check ./libexample.so\n" +
      "  sentry debug-files check MyApp.dSYM/Contents/Resources/DWARF/MyApp\n" +
      "  sentry debug-files check ./app.pdb --json\n\n" +
      "Exits non-zero if the file is not usable for symbolication.",
  },
  output: {
    human: formatCheckResult,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Path to the debug information file",
          parse: String,
          placeholder: "path",
        },
      ],
    },
    flags: {},
  },
  async *func(
    this: SentryContext,
    _flags: Record<string, never>,
    path: string
  ) {
    const content = await readDebugFile(path);

    let archive: DifArchiveInfo;
    try {
      archive = parseDebugFile(new Uint8Array(content));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `'${path}' is not a recognized debug information file: ${msg}`,
        "path"
      );
    }

    const usable = isUsable(archive);
    yield new CommandOutput<DebugFilesCheckResult>({
      path,
      fileFormat: archive.fileFormat,
      objects: archive.objects,
      usable,
    });

    if (!usable) {
      // this.process === the global process in production (see buildContext);
      // using it here keeps the exit-code observable in tests.
      this.process.exitCode = 1;
      return {
        hint: `No usable debug information found. Try: ${USAGE_HINT}`,
      };
    }
  },
});
