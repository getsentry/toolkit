/**
 * sentry sourcemap inject <dir>
 *
 * Scan a directory for JavaScript files and their companion sourcemaps,
 * then inject Sentry debug IDs for reliable sourcemap resolution.
 */

import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import {
  colorTag,
  mdKvTable,
  renderMarkdown,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import {
  assertDirectoryReadable,
  buildEmptyDiscoveryError,
  buildIgnoreMatcher,
  diagnoseEmptyDiscovery,
  discoverFilePairs,
  type InjectResult,
  injectDirectory,
} from "../../lib/sourcemap/inject.js";

/** Result type for the inject command output. */
type InjectCommandResult = {
  modified: number;
  skipped: number;
  files: InjectResult[];
};

/** Format human-readable output for inject results. */
function formatInjectResult(data: InjectCommandResult): string {
  const lines: string[] = [];
  lines.push(
    mdKvTable([
      ["Files modified", String(data.modified)],
      ["Files skipped", String(data.skipped)],
    ])
  );

  if (data.files.length > 0) {
    lines.push("");
    for (const file of data.files) {
      const status = file.injected ? "✓" : "–";
      lines.push(
        `${status} ${file.jsPath} → ${colorTag("muted", file.debugId)}`
      );
    }
  }

  return renderMarkdown(lines.join("\n"));
}

export const injectCommand = buildCommand({
  docs: {
    brief: "Inject debug IDs into JavaScript files and sourcemaps",
    fullDescription:
      "Scans a directory for .js/.mjs/.cjs files and their companion .map files, " +
      "then injects Sentry debug IDs for reliable sourcemap resolution.\n\n" +
      "Existing debug IDs are preserved; missing runtime registration snippets are added.\n" +
      "Files that already register their debug ID at runtime are left unchanged.\n\n" +
      "Exits with an error if zero JS + sourcemap pairs are discovered " +
      "(typical cause: bundler not emitting .map files). Pass " +
      "--allow-empty to suppress this check for directories that may " +
      "legitimately be empty.\n\n" +
      "Usage:\n" +
      "  sentry sourcemap inject ./dist\n" +
      "  sentry sourcemap inject ./build --ext .js,.mjs\n" +
      "  sentry sourcemap inject ./out --dry-run\n" +
      "  sentry sourcemap inject ./maybe-empty --allow-empty",
  },
  // Purely local file operation — no Sentry API calls, no auth needed.
  auth: false,
  output: {
    human: formatInjectResult,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Directory to scan for JS + sourcemap pairs",
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
      "dry-run": {
        kind: "boolean",
        brief: "Show what would be modified without writing",
        optional: true,
        default: false,
      },
      "allow-empty": {
        kind: "boolean",
        brief:
          "Exit successfully when no JS + sourcemap pairs are found " +
          "(default: error out to catch silent build misconfigurations)",
        optional: true,
        default: false,
      },
    },
  },
  async *func(
    this: SentryContext,
    flags: {
      ext?: string;
      ignore?: string;
      "ignore-file"?: string;
      "dry-run"?: boolean;
      "allow-empty"?: boolean;
    },
    dir: string
  ) {
    // Discover pairs read-only first so we don't error after partially
    // mutating files. Zero *discovered* pairs (distinct from zero
    // *injected* — the idempotent re-run case) almost always means a
    // missing-.map bundler misconfiguration; --allow-empty opts out.
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

    const pairs = await discoverFilePairs(dir, extSet, ignoreMatcher);
    if (pairs.length === 0 && !flags["allow-empty"]) {
      const diag = await diagnoseEmptyDiscovery(dir, { extensions });
      throw buildEmptyDiscoveryError(dir, diag);
    }

    const results = await injectDirectory(dir, {
      extensions,
      ignoreMatcher,
      dryRun: flags["dry-run"],
    });

    const modified = results.filter((r) => r.injected).length;
    const skipped = results.length - modified;

    yield new CommandOutput<InjectCommandResult>({
      modified,
      skipped,
      files: results,
    });

    if (modified > 0) {
      return {
        hint: "Run `sentry sourcemap upload` to upload the injected files to Sentry",
      };
    }
    return {};
  },
});
