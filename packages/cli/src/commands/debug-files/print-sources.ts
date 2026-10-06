/**
 * sentry debug-files print-sources <path>
 *
 * List the source files referenced by a debug information file (Mach-O/dSYM,
 * ELF, PE/PDB, Portable PDB, Breakpad, source bundles). For each referenced
 * file it reports whether the source is embedded, available via a source link,
 * or present on the local disk.
 *
 * This mirrors the legacy `sentry-cli difutil print-sources` and complements
 * `bundle-sources`. Local-only — no API calls. Parsing happens in-process via
 * the bundled `symbolic` WASM module (see `src/lib/dif/`).
 */

import { existsSync } from "node:fs";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import {
  type DifSourcesInfo,
  listSources,
  selectBundledObject,
} from "../../lib/dif/index.js";
import { ValidationError } from "../../lib/errors.js";
import {
  colorTag,
  renderMarkdown,
  safeCodeSpan,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { readDebugFile } from "./read-file.js";

const USAGE_HINT = "sentry debug-files print-sources <path>";

const log = logger.withTag("debug-files.print-sources");

/** A referenced source file augmented with local-disk availability. */
type PrintSourcesFile = DifSourcesInfo["objects"][number]["files"][number] & {
  /** Whether the file exists on the local disk; `null` when embedded or linked. */
  availableLocally: boolean | null;
};

/** Per-object referenced sources for the command output. */
type PrintSourcesObject = {
  debugId: string;
  fileFormat: string;
  /**
   * Whether this object carries debug info. Exposed so `--json` consumers can
   * apply the same `selectBundledObject` rule `bundle-sources` uses to pick the
   * single slice it bundles.
   */
  hasDebugInfo: boolean;
  /** Error message if enumerating this object's sources failed, else `null`. */
  enumerationError: string | null;
  files: PrintSourcesFile[];
};

/** Structured result yielded by the command (and serialized to JSON). */
type PrintSourcesResult = {
  path: string;
  objects: PrintSourcesObject[];
};

/** Short, human-readable description of where a referenced source lives. */
function describeSource(file: PrintSourcesFile): string {
  if (file.url !== null) {
    return colorTag("muted", `source link: ${file.url}`);
  }
  if (file.resolved) {
    return colorTag("muted", "embedded");
  }
  if (file.availableLocally) {
    return colorTag("muted", "not embedded, available locally");
  }
  return colorTag("muted", "not embedded, not available locally");
}

/** Human formatter: one section per object, listing each referenced source. */
function formatPrintSources(data: PrintSourcesResult): string {
  if (data.objects.length === 0) {
    return renderMarkdown(colorTag("muted", "No objects found in the file."));
  }

  const sections = data.objects.map((object) => {
    const header = `${object.fileFormat} ${safeCodeSpan(object.debugId)}`;
    if (object.enumerationError !== null) {
      return `${header} — ${colorTag("muted", `could not read sources: ${object.enumerationError}`)}`;
    }
    if (object.files.length === 0) {
      return `${header} — ${colorTag("muted", "no referenced sources")}`;
    }
    const lines = object.files.map(
      (file) => `- ${safeCodeSpan(file.path)} — ${describeSource(file)}`
    );
    const count = object.files.length;
    return `${header} — ${count} source file${count === 1 ? "" : "s"}:\n\n${lines.join("\n")}`;
  });

  return renderMarkdown(sections.join("\n\n"));
}

export const printSourcesCommand = buildCommand({
  // Local-only: parses + enumerates in-process, no API calls.
  auth: false,
  docs: {
    brief: "List the source files a debug file references",
    fullDescription:
      "List the source files referenced by a debug information file. For each " +
      "referenced file it reports whether the source is embedded in the file, " +
      "available via a source link, or present on the local disk — useful for " +
      "checking what `bundle-sources` would include. Supports Mach-O/dSYM, " +
      "ELF, PE/PDB, Portable PDB, and Breakpad.\n\n" +
      "The format is auto-detected. This command is local-only and makes no " +
      "network requests.\n\n" +
      "Usage:\n" +
      "  sentry debug-files print-sources ./libexample.so\n" +
      "  sentry debug-files print-sources ./app.pdb --json",
  },
  output: {
    human: formatPrintSources,
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

    let info: DifSourcesInfo;
    try {
      info = listSources(new Uint8Array(content));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `'${path}' is not a recognized debug information file: ${msg}`,
        "path"
      );
    }

    const objects: PrintSourcesObject[] = info.objects.map((object) => ({
      debugId: object.debugId,
      fileFormat: object.fileFormat,
      hasDebugInfo: object.hasDebugInfo,
      enumerationError: object.enumerationError,
      files: object.files.map((file) => ({
        ...file,
        // Local availability only matters for files that aren't embedded/linked.
        availableLocally: file.resolved ? null : existsSync(file.path),
      })),
    }));

    // Surface objects whose source enumeration failed: their empty file list is
    // a degraded result, not a genuine "no sources" — warn so it isn't read as
    // the latter (the command still exits zero since the file itself parsed).
    const failed = objects.filter((object) => object.enumerationError !== null);
    for (const object of failed) {
      log.warn(
        `Could not enumerate sources for ${object.debugId} in '${path}': ${object.enumerationError}`
      );
    }

    // All slices are listed for inspection, but `bundle-sources` only bundles
    // one of them. Warn (mirroring `bundle-sources`) so the preview does not
    // imply every listed source would end up in the bundle.
    const bundled = selectBundledObject(info.objects);
    if (info.objects.length > 1 && bundled) {
      log.warn(
        `'${path}' contains ${info.objects.length} objects; ` +
          `\`bundle-sources\` would bundle sources for ${bundled.debugId} only. ` +
          "Other slices are not included."
      );
    }

    yield new CommandOutput<PrintSourcesResult>({ path, objects });

    if (objects.length === 0) {
      return { hint: `No objects found in '${path}'. Try: ${USAGE_HINT}` };
    }
    const total = objects.reduce((sum, object) => sum + object.files.length, 0);
    if (total === 0) {
      // If any slice failed to enumerate, "no sources" is not a safe
      // conclusion — even when other slices genuinely reference none — so the
      // hint must not contradict the per-slice enumeration warnings.
      if (failed.length > 0) {
        return {
          hint: `Could not read referenced sources from '${path}'. Re-run with --log-level=debug for details.`,
        };
      }
      return {
        hint: `No referenced sources found in '${path}'. Try: ${USAGE_HINT}`,
      };
    }
    return {
      hint: `Bundle these into a source bundle with: sentry debug-files bundle-sources ${path}`,
    };
  },
});
