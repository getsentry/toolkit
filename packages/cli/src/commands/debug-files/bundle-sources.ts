/**
 * sentry debug-files bundle-sources <path>
 *
 * Build a source bundle from the source files referenced by a debug
 * information file (Mach-O/dSYM, ELF, PE/PDB, Portable PDB, WASM, Breakpad).
 * The bundle is a ZIP archive carrying the object's debug id, which can be
 * uploaded to Sentry for source context in stack traces.
 *
 * Source files are read from the paths recorded in the debug info, so this is
 * typically run on the build machine right after compiling. Referenced files
 * that are not present locally are skipped.
 *
 * Local-only — no API calls. Parsing and bundling happen in-process via the
 * bundled `symbolic` WASM module (see `src/lib/dif/`).
 */

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { createSourceBundle } from "../../lib/dif/index.js";
import { ValidationError } from "../../lib/errors.js";
import {
  colorTag,
  mdKvTable,
  renderMarkdown,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { readDebugFile } from "./read-file.js";

const log = logger.withTag("debug-files.bundle-sources");

const USAGE_HINT = "sentry debug-files bundle-sources <path>";

/** Structured result for the bundle-sources command. */
type BundleSourcesResult = {
  /** Path to the inspected debug information file. */
  path: string;
  /** Path the bundle was written to, or `null` if no bundle was produced. */
  outputPath: string | null;
  /** Debug id of the bundled object, or `null` if the file has no objects. */
  debugId: string | null;
  /** Number of source files included in the bundle. */
  fileCount: number;
};

/** Human-readable formatter for the bundle result. */
function formatBundleResult(data: BundleSourcesResult): string {
  if (data.outputPath === null) {
    return renderMarkdown(
      colorTag(
        "warning",
        "No source files referenced by this debug file were found on disk; nothing was bundled."
      )
    );
  }
  const rows: [string, string][] = [
    ["Output", data.outputPath],
    ["Debug ID", data.debugId ?? colorTag("muted", "none")],
    ["Files bundled", String(data.fileCount)],
  ];
  return renderMarkdown(mdKvTable(rows));
}

export const bundleSourcesCommand = buildCommand({
  // Local-only: parses + bundles in-process, no API calls.
  auth: false,
  docs: {
    brief: "Bundle a debug file's source files for source context",
    fullDescription:
      "Build a source bundle from the source files referenced by a debug " +
      "information file. The bundle is a ZIP archive stamped with the " +
      "object's debug id that can be uploaded to Sentry (debug-files upload) " +
      "for source context in stack traces. Supports Mach-O/dSYM, ELF, " +
      "PE/PDB, Portable PDB, WebAssembly, and Breakpad.\n\n" +
      "Source files are read from the paths recorded in the debug info, so " +
      "this is normally run on the build machine right after compiling. " +
      "Referenced files that are not present locally are skipped. The format " +
      "is auto-detected, and this command makes no network requests.\n\n" +
      "Usage:\n" +
      "  sentry debug-files bundle-sources ./libexample.so\n" +
      "  sentry debug-files bundle-sources ./app.pdb -o ./app.src.zip\n\n" +
      "Exits non-zero if no referenced source files are found on disk.",
  },
  output: {
    human: formatBundleResult,
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
    flags: {
      output: {
        kind: "parsed",
        parse: String,
        brief:
          "Output path for the source bundle ZIP (default: <path>.src.zip)",
        optional: true,
      },
    },
    aliases: {
      o: "output",
    },
  },
  async *func(this: SentryContext, flags: { output?: string }, path: string) {
    const content = await readDebugFile(path);

    let result: ReturnType<typeof createSourceBundle>;
    try {
      result = createSourceBundle(
        new Uint8Array(content),
        basename(path),
        (sourcePath) => {
          try {
            return readFileSync(sourcePath);
          } catch (err) {
            log.debug(
              `Source file not available, skipping: ${sourcePath}`,
              err
            );
            return null;
          }
        }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `'${path}' is not a recognized debug information file: ${msg}`,
        "path"
      );
    }

    if (result.bundle === null || result.fileCount === 0) {
      // this.process === the global process in production (see buildContext);
      // using it here keeps the exit-code observable in tests.
      this.process.exitCode = 1;
      yield new CommandOutput<BundleSourcesResult>({
        path,
        outputPath: null,
        debugId: result.debugId,
        fileCount: 0,
      });
      return {
        hint: `No source files found on disk for '${path}'. This is normally run on the build machine. Try: ${USAGE_HINT}`,
      };
    }

    if (result.objectCount > 1) {
      log.warn(
        `'${path}' contains ${result.objectCount} objects; bundled sources for ${result.debugId} only. Other slices are not included.`
      );
    }

    const outputPath = resolve(flags.output ?? `${path}.src.zip`);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, result.bundle);

    yield new CommandOutput<BundleSourcesResult>({
      path,
      outputPath,
      debugId: result.debugId,
      fileCount: result.fileCount,
    });

    return {
      hint: `Created ${outputPath} with ${result.fileCount} source file(s). Upload with: sentry debug-files upload`,
    };
  },
});
