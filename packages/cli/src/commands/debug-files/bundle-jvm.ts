/**
 * sentry debug-files bundle-jvm <path>
 *
 * Create a JVM source bundle from a directory of JVM source files.
 * The bundle is a ZIP archive that can be uploaded to Sentry via
 * `debug-files upload --type jvm` for source context in stack traces.
 *
 * This command is local-only — it makes no API calls.
 */

import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { ValidationError } from "../../lib/errors.js";
import { mdKvTable, renderMarkdown } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { buildJvmBundle } from "../../lib/jvm-bundle.js";
import { logger } from "../../lib/logger.js";

const log = logger.withTag("debug-files.bundle-jvm");

/** UUID format: 8-4-4-4-12 hex with hyphens. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Data shape yielded by the command and rendered by both human and JSON modes. */
type BundleJvmResult = {
  outputPath: string;
  debugId: string;
  fileCount: number;
  collisionCount: number;
};

/** Human-readable formatter for the bundle result. */
function formatBundleResult(data: BundleJvmResult): string {
  const rows: [string, string][] = [
    ["Output", data.outputPath],
    ["Debug ID", data.debugId],
    ["Files bundled", String(data.fileCount)],
  ];

  if (data.collisionCount > 0) {
    rows.push(["URL collisions", String(data.collisionCount)]);
  }

  return renderMarkdown(mdKvTable(rows));
}

export const bundleJvmCommand = buildCommand({
  auth: false,
  docs: {
    brief: "Create a JVM source bundle for source context",
    fullDescription:
      "Create a JVM source bundle from a directory of Java, Kotlin, Scala, " +
      "Groovy, or Clojure source files. The bundle is a ZIP archive that " +
      "can be uploaded to Sentry for source context in JVM stack traces.\n\n" +
      "This command is local-only — it makes no network requests.",
  },
  output: {
    human: formatBundleResult,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Directory containing JVM source files",
          parse: String,
          placeholder: "path",
        },
      ],
    },
    flags: {
      output: {
        kind: "parsed",
        parse: String,
        brief: "Output directory for the bundle ZIP",
      },
      "debug-id": {
        kind: "parsed",
        parse: String,
        brief: "Debug ID (UUID) to stamp on the bundle",
      },
      exclude: {
        kind: "parsed",
        parse: String,
        brief: "Additional directory names to exclude (repeatable)",
        optional: true,
        variadic: true,
      },
    },
    aliases: {
      o: "output",
      d: "debug-id",
      e: "exclude",
    },
  },
  async *func(
    this: SentryContext,
    flags: {
      output: string;
      "debug-id": string;
      exclude?: string[];
    },
    sourcePath: string
  ) {
    // 1. Validate debug ID format
    if (!UUID_RE.test(flags["debug-id"])) {
      throw new ValidationError(
        `Invalid debug ID format: '${flags["debug-id"]}'. ` +
          "Expected UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "debug-id"
      );
    }

    // 2. Validate source path exists and is a directory
    const resolvedSource = resolve(sourcePath);
    const srcStat = await stat(resolvedSource).catch(() => {
      throw new ValidationError(
        `Source path '${sourcePath}' does not exist.`,
        "path"
      );
    });
    if (!srcStat.isDirectory()) {
      throw new ValidationError(
        `Source path '${sourcePath}' is not a directory.`,
        "path"
      );
    }

    // 3. Create output directory if needed
    const resolvedOutput = resolve(flags.output);
    await mkdir(resolvedOutput, { recursive: true });

    // 4. Build the bundle
    const outputFile = join(resolvedOutput, `${flags["debug-id"]}.zip`);

    const result = await buildJvmBundle({
      sourcePath: resolvedSource,
      outputPath: outputFile,
      debugId: flags["debug-id"],
      excludePatterns: flags.exclude,
    });

    if (result.fileCount === 0) {
      log.warn("No JVM source files found in the given directory.");
    }

    // 5. Yield result
    yield new CommandOutput<BundleJvmResult>({
      outputPath: result.outputPath,
      debugId: flags["debug-id"],
      fileCount: result.fileCount,
      collisionCount: result.collisionCount,
    });

    return {
      hint: `Created ${outputFile} with ${result.fileCount} source file(s)`,
    };
  },
});
