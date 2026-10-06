/**
 * sentry dart-symbol-map upload <path>
 *
 * Upload a Dart/Flutter obfuscation map to Sentry for deobfuscating
 * Dart exception types. The map must be a JSON array of strings with
 * an even number of entries (alternating obfuscated/original names).
 *
 * Requires a `--debug-id` flag to associate the map with a native
 * debug file. The sentry-dart-plugin extracts this from the companion
 * dSYM/ELF file before calling this command.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { SentryContext } from "../../context.js";
import { uploadDartSymbolMap } from "../../lib/api/dart-symbols.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError, ValidationError } from "../../lib/errors.js";
import { mdKvTable, renderMarkdown } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { resolveOrgAndProject } from "../../lib/resolve-target.js";

const log = logger.withTag("dart-symbol-map.upload");

// Types

/** Structured result for the upload command. */
type DartSymbolMapUploadResult = {
  /** Organization slug. Omitted for --no-upload. */
  org?: string;
  /** Project slug. Omitted for --no-upload. */
  project?: string;
  /** Path to the mapping file. */
  path: string;
  /** Debug ID associated with the mapping. */
  debugId: string;
  /** Whether the file was uploaded. */
  uploaded: boolean;
};

// Formatter

const USAGE_HINT = "sentry dart-symbol-map upload --debug-id <uuid> <path>";

/** Format human-readable output for upload results. */
function formatUploadResult(data: DartSymbolMapUploadResult): string {
  const rows: [string, string][] = [];
  if (data.org) {
    rows.push(["Organization", data.org]);
  }
  if (data.project) {
    rows.push(["Project", data.project]);
  }
  rows.push(["File", data.path]);
  rows.push(["Debug ID", data.debugId]);
  rows.push(["Uploaded", data.uploaded ? "yes" : "no (dry run)"]);
  return renderMarkdown(mdKvTable(rows));
}

// Helpers

/** UUID format: 8-4-4-4-12 hex with hyphens. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a debug ID is a well-formed UUID.
 *
 * @throws {ValidationError} If the debug ID is malformed
 */
function validateDebugId(debugId: string): void {
  if (!UUID_RE.test(debugId)) {
    throw new ValidationError(
      `Invalid debug ID format: '${debugId}'. Expected UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`,
      "debug-id"
    );
  }
}

/**
 * Validate that the file content is a valid dart symbol map.
 *
 * Must be a JSON array of strings with an even number of entries.
 *
 * @throws {ValidationError} If the content is not valid
 */
function validateDartSymbolMap(content: Buffer, path: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf-8"));
  } catch {
    throw new ValidationError(
      `Invalid dart symbol map '${path}': not valid JSON`,
      "path"
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ValidationError(
      `Invalid dart symbol map '${path}': expected a JSON array, got ${typeof parsed}`,
      "path"
    );
  }

  for (let i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] !== "string") {
      throw new ValidationError(
        `Invalid dart symbol map '${path}': entry at index ${i} is ${typeof parsed[i]}, expected string`,
        "path"
      );
    }
  }

  if (parsed.length % 2 !== 0) {
    throw new ValidationError(
      `Invalid dart symbol map '${path}': expected an even number of entries (pairs), got ${parsed.length}`,
      "path"
    );
  }
}

/**
 * Read a mapping file from disk with descriptive error handling.
 *
 * @param path - Path to the mapping file
 * @returns File content as a Buffer
 * @throws {ValidationError} On ENOENT, EISDIR, or other read failures
 */
async function readMappingFile(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ValidationError(
        `Dart symbol map '${path}' does not exist.`,
        "path"
      );
    }
    if (code === "EISDIR") {
      throw new ValidationError(
        `Path '${path}' is a directory, not a dart symbol map file.`,
        "path"
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      `Cannot read dart symbol map '${path}': ${msg}`,
      "path"
    );
  }
}

// Command

export const uploadCommand = buildCommand({
  // Auth is not required for --no-upload (dry-run mode).
  // The upload path calls resolveOrgAndProject which triggers auth.
  auth: false,
  docs: {
    brief: "Upload a Dart/Flutter symbol map to Sentry",
    fullDescription:
      "Upload a Dart/Flutter obfuscation map for deobfuscating Dart exception " +
      "types. The map must be a JSON array of strings with an even number of " +
      "entries (alternating obfuscated/original name pairs).\n\n" +
      "A debug ID (--debug-id) is required to associate the map with its " +
      "companion native debug file (dSYM/ELF). The sentry-dart-plugin " +
      "extracts this automatically.\n\n" +
      "Usage:\n" +
      "  sentry dart-symbol-map upload --debug-id <uuid> mapping.json\n" +
      "  sentry dart-symbol-map upload --debug-id <uuid> mapping.json --no-upload\n" +
      "  sentry dart-symbol-map upload --debug-id <uuid> mapping.json --json\n\n" +
      "Supported on Sentry SaaS and self-hosted >= 25.8.0.",
  },
  output: {
    human: formatUploadResult,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Path to the dart symbol map JSON file",
          parse: String,
          placeholder: "path",
        },
      ],
    },
    flags: {
      "debug-id": {
        kind: "parsed",
        parse: String,
        brief: "Debug ID (UUID) from the companion native debug file",
      },
      "no-upload": {
        kind: "boolean",
        brief: "Validate the file without uploading (dry-run)",
        optional: true,
        default: false,
      },
    },
    aliases: {
      d: "debug-id",
    },
  },
  async *func(
    this: SentryContext,
    flags: {
      "debug-id": string;
      "no-upload"?: boolean;
    },
    mappingPath: string
  ) {
    // 1. Validate debug ID format
    validateDebugId(flags["debug-id"]);

    // 2. Read and validate the mapping file
    const content = await readMappingFile(mappingPath);
    if (content.length === 0) {
      throw new ValidationError(
        `Dart symbol map '${mappingPath}' is empty.`,
        "path"
      );
    }
    validateDartSymbolMap(content, mappingPath);

    // 3. --no-upload: validate only, no auth needed
    if (flags["no-upload"]) {
      yield new CommandOutput<DartSymbolMapUploadResult>({
        path: mappingPath,
        debugId: flags["debug-id"],
        uploaded: false,
      });
      return {
        hint: `Validated dart symbol map: ${mappingPath} (debug ID: ${flags["debug-id"]})`,
      };
    }

    // 4. Resolve org/project
    const resolved = await resolveOrgAndProject({
      cwd: this.cwd,
      usageHint: USAGE_HINT,
    });
    if (!resolved) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }
    const { org, project } = resolved;

    // 5. Upload
    log.debug(
      `Uploading dart symbol map '${mappingPath}' (debug ID: ${flags["debug-id"]}) to ${org}/${project}`
    );
    await uploadDartSymbolMap({
      org,
      project,
      mapping: {
        path: basename(mappingPath),
        debugId: flags["debug-id"],
        content,
      },
    });

    // 6. Yield result
    yield new CommandOutput<DartSymbolMapUploadResult>({
      org,
      project,
      path: mappingPath,
      debugId: flags["debug-id"],
      uploaded: true,
    });

    return {
      hint: `Uploaded dart symbol map: ${mappingPath} (debug ID: ${flags["debug-id"]})`,
    };
  },
});
