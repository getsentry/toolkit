/**
 * sentry sourcemap resolve <dir>
 *
 * Read-only diagnostic that reports how each JavaScript file's sourcemap
 * resolves (convention, external `sourceMappingURL`, inline `data:` URL, or
 * none) and whether a Sentry debug ID has been injected. Mirrors the legacy
 * `sentry-cli sourcemaps resolve` command without mutating any files.
 */

import { relative, resolve as resolvePath } from "node:path";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import {
  colorTag,
  escapeMarkdownCell,
  mdKvTable,
  renderMarkdown,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  assertDirectoryReadable,
  buildIgnoreMatcher,
  resolveDirectorySourcemaps,
} from "../../lib/sourcemap/inject.js";

/** Per-file resolution entry for the command output. Uses relative paths only. */
type ResolveFileEntry = {
  /** JS path relative to the scanned directory. */
  path: string;
  /** Companion sourcemap path relative to the scanned directory, if any. */
  mapPath?: string;
  /** Raw `sourceMappingURL` directive value, if any. */
  sourceMappingUrl?: string;
  /** True when the sourceMappingURL is an inline data: URL. */
  inline: boolean;
  /** True when the sourceMappingURL is a remote http(s) reference. */
  remote: boolean;
  /** The embedded `//# debugId=<uuid>` value, if any. */
  debugId?: string;
};

/** Result type for the resolve command output. */
type ResolveCommandResult = {
  /** Total JS files scanned. */
  total: number;
  /** Files with a resolvable sourcemap (companion file, inline, or remote). */
  resolved: number;
  /** Files with an injected debug ID. */
  withDebugId: number;
  /** Per-file resolution details (relative paths only). */
  files: ResolveFileEntry[];
};

/**
 * Describe how the sourcemap resolved, for the human table's "Source map"
 * column.
 */
function describeMapStatus(file: ResolveFileEntry): string {
  if (file.mapPath) {
    return escapeMarkdownCell(file.mapPath);
  }
  if (file.inline) {
    return colorTag("muted", "inline (data: URL)");
  }
  if (file.remote) {
    return colorTag("muted", "remote URL");
  }
  return colorTag("red", "not found");
}

/** True when a file has any kind of sourcemap (companion, inline, or remote). */
function hasSourcemap(file: ResolveFileEntry): boolean {
  return !!file.mapPath || file.inline || file.remote;
}

/** Format human-readable output for resolve results. */
function formatResolveResult(data: ResolveCommandResult): string {
  const lines: string[] = [];
  lines.push(
    mdKvTable([
      ["JS files", String(data.total)],
      ["With sourcemap", String(data.resolved)],
      ["With debug ID", String(data.withDebugId)],
    ])
  );

  if (data.files.length > 0) {
    lines.push("");
    lines.push("| File | Source map | Debug ID |");
    lines.push("| --- | --- | --- |");
    for (const file of data.files) {
      const debugId = file.debugId
        ? escapeMarkdownCell(file.debugId)
        : colorTag("muted", "—");
      lines.push(
        `| ${escapeMarkdownCell(file.path)} | ${describeMapStatus(file)} | ${debugId} |`
      );
    }
  }

  return renderMarkdown(lines.join("\n"));
}

export const resolveCommand = buildCommand({
  docs: {
    brief: "Resolve and report sourcemap linkage for JavaScript files",
    fullDescription:
      "Read-only diagnostic that scans a directory for .js/.mjs/.cjs files " +
      "and reports, for each file, how its sourcemap resolves (companion " +
      ".map file, external sourceMappingURL directive, inline data: URL, or " +
      "none) and whether a Sentry debug ID has been injected.\n\n" +
      "This command never modifies files. Use it to debug why " +
      "`sentry sourcemap upload` may not find the expected sourcemaps.\n\n" +
      "Usage:\n" +
      "  sentry sourcemap resolve ./dist\n" +
      "  sentry sourcemap resolve ./build --ext .js,.mjs\n" +
      "  sentry sourcemap resolve ./out --json",
  },
  // Purely local file operation — no Sentry API calls, no auth needed.
  auth: false,
  output: {
    human: formatResolveResult,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Directory to scan for JS files",
          parse: String,
          placeholder: "directory",
        },
      ],
    },
    flags: {
      ext: {
        kind: "parsed",
        parse: String,
        brief:
          "Comma-separated file extensions to process (default: .js,.cjs,.mjs)",
        optional: true,
      },
      ignore: {
        kind: "parsed",
        parse: String,
        brief: "Comma-separated glob patterns to exclude (gitignore-style)",
        optional: true,
      },
      "ignore-file": {
        kind: "parsed",
        parse: String,
        brief: "Path to a file with gitignore-style patterns to exclude",
        optional: true,
      },
    },
  },
  async *func(
    this: SentryContext,
    flags: {
      ext?: string;
      ignore?: string;
      "ignore-file"?: string;
    },
    dir: string
  ) {
    await assertDirectoryReadable(dir);

    const extensions = flags.ext?.split(",").map((e) => e.trim());
    const extSet = extensions
      ? new Set(extensions.map((e) => (e.startsWith(".") ? e : `.${e}`)))
      : undefined;

    const ignorePatterns = flags.ignore
      ? flags.ignore.split(",").map((p) => p.trim())
      : undefined;
    const ignoreMatcher = await buildIgnoreMatcher(
      ignorePatterns,
      flags["ignore-file"]
    );

    const resolutions = await resolveDirectorySourcemaps(
      dir,
      extSet,
      ignoreMatcher
    );

    const absDir = resolvePath(dir);
    const files: ResolveFileEntry[] = resolutions.map((r) => ({
      path: relative(absDir, r.jsPath) || r.jsPath,
      mapPath: r.mapPath ? relative(absDir, r.mapPath) : undefined,
      sourceMappingUrl: r.sourceMappingUrl,
      inline: r.inline,
      remote: r.remote,
      debugId: r.debugId,
    }));

    // Single pass over files to tally both counters, avoiding two full filters.
    let resolved = 0;
    let withDebugId = 0;
    for (const file of files) {
      if (hasSourcemap(file)) {
        resolved += 1;
      }
      if (file.debugId) {
        withDebugId += 1;
      }
    }

    yield new CommandOutput<ResolveCommandResult>({
      total: files.length,
      resolved,
      withDebugId,
      files,
    });

    if (files.length === 0) {
      return { hint: "No JavaScript files found in this directory." };
    }
    if (withDebugId < files.length) {
      return {
        hint: "Run `sentry sourcemap inject` to add debug IDs to files missing them.",
      };
    }
    return {};
  },
});
