/**
 * sentry proguard upload <path>...
 *
 * Upload ProGuard/R8 mapping files to Sentry using the DIF
 * chunk-upload protocol. Each mapping file is bundled as
 * `proguard/<uuid>.txt` where UUID is derived from the file content.
 * Org/project resolved via standard cascade (DSN auto-detection,
 * env vars, config defaults).
 */

import { readFile } from "node:fs/promises";
import type { SentryContext } from "../../context.js";
import type { ProguardMapping } from "../../lib/api/proguard.js";
import { uploadProguardMappings } from "../../lib/api/proguard.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError, ValidationError } from "../../lib/errors.js";
import { mdKvTable, renderMarkdown } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";
import { computeProguardUuid } from "../../lib/proguard.js";
import { resolveOrgAndProject } from "../../lib/resolve-target.js";

const log = logger.withTag("proguard.upload");

// ── Types ───────────────────────────────────────────────────────────

/** Structured result for the proguard upload command. */
type ProguardUploadResult = {
  /** Organization slug. Omitted when --no-upload short-circuits before
   * org/project resolution. */
  org?: string;
  /** Project slug. Omitted in the same short-circuit case. */
  project?: string;
  /** Per-file upload results. */
  mappings: Array<{
    /** Path to the mapping file. */
    path: string;
    /** Mapping UUID (computed or forced). */
    uuid: string;
  }>;
  /** Number of mapping files uploaded. */
  filesUploaded: number;
};

// ── Formatter ───────────────────────────────────────────────────────

const USAGE_HINT = "sentry proguard upload <path>...";

/** Format human-readable output for upload results. */
function formatUploadResult(data: ProguardUploadResult): string {
  const rows: [string, string][] = [];
  if (data.org) {
    rows.push(["Organization", data.org]);
  }
  if (data.project) {
    rows.push(["Project", data.project]);
  }
  rows.push(["Files uploaded", String(data.filesUploaded)]);
  for (const m of data.mappings) {
    rows.push(["UUID", `${m.uuid}  (${m.path})`]);
  }
  return renderMarkdown(mdKvTable(rows));
}

// ── Helpers ─────────────────────────────────────────────────────────

/** UUID format: 8-4-4-4-12 hex with hyphens. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a user-provided UUID string is well-formed.
 *
 * @param uuid - The UUID string to validate
 * @throws {ValidationError} If the UUID is malformed
 */
function validateUuidFormat(uuid: string): void {
  if (!UUID_RE.test(uuid)) {
    throw new ValidationError(
      `Invalid UUID format: '${uuid}'. Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`,
      "uuid"
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
  let content: Buffer;
  try {
    content = await readFile(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ValidationError(
        `ProGuard mapping file '${path}' does not exist.`,
        "path"
      );
    }
    if (code === "EISDIR") {
      throw new ValidationError(
        `Path '${path}' is a directory, not a ProGuard mapping file.`,
        "path"
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      `Cannot read ProGuard mapping file '${path}': ${msg}`,
      "path"
    );
  }
  if (content.length === 0) {
    throw new ValidationError(
      `ProGuard mapping file '${path}' is empty.`,
      "path"
    );
  }
  return content;
}

/**
 * Deduplicate mappings with identical content (same UUID = same content).
 * Logs a warning for each skipped duplicate.
 */
function deduplicateMappings(mappings: ProguardMapping[]): ProguardMapping[] {
  const seen = new Map<string, string>();
  const unique: ProguardMapping[] = [];
  for (const m of mappings) {
    const existing = seen.get(m.uuid);
    if (existing) {
      log.warn(
        `Skipping '${m.path}': identical content as '${existing}' (UUID ${m.uuid})`
      );
      continue;
    }
    seen.set(m.uuid, m.path);
    unique.push(m);
  }
  return unique;
}

// ── Command ─────────────────────────────────────────────────────────

export const uploadCommand = buildCommand({
  // Auth is not required for --no-upload (dry-run mode).
  // The upload path calls resolveOrgAndProject which triggers auth.
  auth: false,
  docs: {
    brief: "Upload ProGuard/R8 mapping files to Sentry",
    fullDescription:
      "Upload one or more ProGuard/R8 mapping files to Sentry using " +
      "the chunk-upload protocol. Each mapping is identified by a " +
      "deterministic UUID derived from its content.\n\n" +
      "Org/project are auto-detected from DSN, env vars, or config defaults.\n\n" +
      "Usage:\n" +
      "  sentry proguard upload mapping.txt\n" +
      "  sentry proguard upload build/mapping1.txt build/mapping2.txt\n" +
      "  sentry proguard upload mapping.txt --uuid 5db7294d-87fc-5726-a5c0-4a90679657a5\n" +
      "  sentry proguard upload mapping.txt --no-upload\n" +
      "  sentry proguard upload mapping.txt --json",
  },
  output: {
    human: formatUploadResult,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        brief: "Paths to ProGuard/R8 mapping files",
        parse: String,
        placeholder: "path",
      },
    },
    flags: {
      uuid: {
        kind: "parsed",
        parse: String,
        brief:
          "Force a specific UUID instead of computing from file content " +
          "(only valid with a single file)",
        optional: true,
      },
      "no-upload": {
        kind: "boolean",
        brief: "Compute and print UUIDs without uploading (dry-run)",
        optional: true,
        default: false,
      },
      "require-one": {
        kind: "boolean",
        brief: "Require at least one mapping file (error if none provided)",
        optional: true,
        default: false,
      },
    },
  },
  async *func(
    this: SentryContext,
    flags: {
      uuid?: string;
      "no-upload"?: boolean;
      "require-one"?: boolean;
    },
    ...paths: string[]
  ) {
    // 1. Validate at least one path is provided
    if (paths.length === 0) {
      if (flags["require-one"]) {
        throw new ValidationError(
          "No mapping files provided (--require-one is set)",
          "path"
        );
      }
      throw new ContextError("Mapping file path(s)", USAGE_HINT, []);
    }

    // 2. Validate --uuid with multiple files is ambiguous
    if (flags.uuid && paths.length > 1) {
      throw new ValidationError(
        "--uuid cannot be used with multiple files (each file needs a unique UUID)",
        "uuid"
      );
    }

    // 3. Validate UUID format if provided
    if (flags.uuid) {
      validateUuidFormat(flags.uuid);
    }

    // 4. Read each file and compute UUID
    const mappings: ProguardMapping[] = [];
    for (const path of paths) {
      const content = await readMappingFile(path);
      const uuid = flags.uuid ?? computeProguardUuid(content);
      mappings.push({ path, uuid, content });
    }

    // 5. Deduplicate mappings with identical content (same UUID = same content)
    const uniqueMappings = deduplicateMappings(mappings);

    // 6. --no-upload: just print UUIDs and return (no auth needed)
    if (flags["no-upload"]) {
      yield new CommandOutput<ProguardUploadResult>({
        mappings: uniqueMappings.map((m) => ({ path: m.path, uuid: m.uuid })),
        filesUploaded: 0,
      });
      return {
        hint:
          uniqueMappings.length === 1
            ? `UUID: ${uniqueMappings[0]?.uuid}`
            : `Computed UUIDs for ${uniqueMappings.length} mapping files`,
      };
    }

    // 7. Resolve org/project
    const resolved = await resolveOrgAndProject({
      cwd: this.cwd,
      usageHint: USAGE_HINT,
    });
    if (!resolved) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }
    const { org, project } = resolved;

    // 8. Upload
    await uploadProguardMappings({
      org,
      project,
      mappings: uniqueMappings,
    });

    // 9. Yield result
    yield new CommandOutput<ProguardUploadResult>({
      org,
      project,
      mappings: uniqueMappings.map((m) => ({ path: m.path, uuid: m.uuid })),
      filesUploaded: uniqueMappings.length,
    });

    return {
      hint:
        uniqueMappings.length === 1
          ? `Uploaded mapping ${uniqueMappings[0]?.uuid}`
          : `Uploaded ${uniqueMappings.length} mapping files`,
    };
  },
});
