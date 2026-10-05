/**
 * ProGuard/R8 DIF Upload API
 *
 * Uploads ProGuard mapping files via the DIF chunk-upload + assemble
 * protocol. Each mapping file is chunked as raw bytes (no ZIP wrapping)
 * and assembled individually through the DIF endpoint.
 *
 * Protocol differences from artifact bundles (sourcemaps):
 * - Raw bytes are chunked directly (no ZIP, no SYSB header)
 * - Assemble endpoint: `projects/{org}/{project}/files/difs/assemble/`
 * - The assemble body keys each file by its overall SHA-1 checksum
 * - Multiple files are sent in a single assemble request
 */

import { type InferOutput, record, string } from "valibot";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import { resolveOrgRegion } from "../region.js";
import {
  ASSEMBLE_MAX_WAIT_MS,
  ASSEMBLE_POLL_INTERVAL_MS,
  type AssembleResponse,
  AssembleResponseSchema,
  type ChunkInfo,
  getChunkUploadOptions,
  hashBuffer,
  pickUploadEncoding,
  uploadMissingBufferChunks,
} from "./chunk-upload.js";
import { apiRequestToRegion } from "./infrastructure.js";

const log = logger.withTag("api.proguard");

// ── Types ───────────────────────────────────────────────────────────

/** A single ProGuard mapping file to upload. */
export type ProguardMapping = {
  /** Filesystem path (for display/logging). */
  path: string;
  /** The UUID for this mapping (content-derived or user-forced). */
  uuid: string;
  /** Pre-read content buffer (avoids double-read when UUID was computed). */
  content: Buffer;
};

/** Options for {@link uploadProguardMappings}. */
export type ProguardUploadOptions = {
  /** Organization slug. */
  org: string;
  /** Project slug. */
  project: string;
  /** Mapping files to upload. */
  mappings: ProguardMapping[];
};

// ── Schemas ─────────────────────────────────────────────────────────

/**
 * DIF assemble response — keyed by overall checksum, each value has
 * the same shape as the standard assemble response.
 */
const DifAssembleResponseSchema = record(string(), AssembleResponseSchema);

type DifAssembleResponse = InferOutput<typeof DifAssembleResponseSchema>;

// ── Internal types ──────────────────────────────────────────────────

/** Per-mapping chunk metadata computed before the assemble request. */
type ChunkedMapping = {
  /** Mapping metadata (path, uuid, content). */
  mapping: ProguardMapping;
  /** Per-chunk SHA-1 checksums and offsets. */
  chunks: ChunkInfo[];
  /** SHA-1 of the entire mapping file. */
  overallChecksum: string;
};

/** Result of checking a DIF assemble response. */
type AssembleCheckResult = {
  /** True when every entry is `"ok"` or `"created"`. */
  allDone: boolean;
  /** SHA-1 checksums the server still needs uploaded. */
  missingChecksums: Set<string>;
};

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Check a DIF assemble response for completion, errors, and missing chunks.
 *
 * @throws {ApiError} If any entry reports an `"error"` state.
 */
function checkAssembleResponse(
  response: DifAssembleResponse,
  checksums: string[],
  endpoint: string
): AssembleCheckResult {
  const missingChecksums = new Set<string>();
  let allDone = true;

  for (const checksum of checksums) {
    const entry: AssembleResponse | undefined = response[checksum];
    if (!entry) {
      log.debug(`No assemble response for checksum ${checksum}`);
      allDone = false;
      continue;
    }
    if (entry.state === "error") {
      throw new ApiError(
        "ProGuard mapping assembly failed",
        500,
        entry.detail ?? "Unknown error",
        endpoint
      );
    }
    if (entry.state === "ok" || entry.state === "created") {
      continue;
    }
    allDone = false;
    for (const sha1 of entry.missingChunks ?? []) {
      missingChecksums.add(sha1);
    }
  }

  return { allDone, missingChecksums };
}

// ── API Functions ───────────────────────────────────────────────────

/**
 * Upload ProGuard mapping files to Sentry via the DIF chunk-upload protocol.
 *
 * Each mapping file's raw bytes are chunked directly (no ZIP wrapping).
 * All mappings are sent in a single assemble request, each keyed by its
 * overall SHA-1 checksum with per-file metadata (`name`, `chunks`).
 *
 * @param options - Upload configuration (org, project, mappings)
 * @throws {ApiError} If the upload or assembly fails
 */
export async function uploadProguardMappings(
  options: ProguardUploadOptions
): Promise<void> {
  const { org, project, mappings } = options;

  // Step 1: Get chunk upload configuration
  const serverOptions = await getChunkUploadOptions(org);
  const encoding = pickUploadEncoding(serverOptions.compression);

  // Step 2: Hash each mapping file into chunks
  const chunkedMappings: ChunkedMapping[] = mappings.map((mapping) => {
    const { chunks, overallChecksum } = hashBuffer(
      mapping.content,
      serverOptions.chunkSize
    );
    return { mapping, chunks, overallChecksum };
  });

  const regionUrl = await resolveOrgRegion(org);
  const assembleEndpoint = `projects/${org}/${project}/files/difs/assemble/`;

  // Step 3: Build assemble body — one entry per mapping, keyed by checksum
  const assembleBody: Record<string, { name: string; chunks: string[] }> = {};
  for (const cm of chunkedMappings) {
    assembleBody[cm.overallChecksum] = {
      name: `/proguard/${cm.mapping.uuid}.txt`,
      chunks: cm.chunks.map((c: ChunkInfo) => c.sha1),
    };
  }

  // Step 4: Request DIF assembly — server reports which chunks it needs
  const { data: firstAssemble } = await apiRequestToRegion<DifAssembleResponse>(
    regionUrl,
    assembleEndpoint,
    {
      method: "POST",
      body: assembleBody,
      schema: DifAssembleResponseSchema,
    }
  );

  const checksums = chunkedMappings.map((cm) => cm.overallChecksum);
  const { allDone, missingChecksums } = checkAssembleResponse(
    firstAssemble,
    checksums,
    assembleEndpoint
  );

  if (allDone) {
    return;
  }

  // Step 5: Upload missing chunks in parallel across all mappings
  for (const cm of chunkedMappings) {
    await uploadMissingBufferChunks({
      chunks: cm.chunks,
      missingChecksums,
      content: cm.mapping.content,
      serverOptions,
      encoding,
      regionUrl,
    });
  }

  // Step 6: Poll assemble endpoint until all mappings are done
  await pollDifAssembly({
    regionUrl,
    endpoint: assembleEndpoint,
    body: assembleBody,
    checksums,
  });
}

/**
 * Poll a DIF assemble endpoint until all entries report completion.
 *
 * The DIF endpoint returns a per-checksum keyed response. This checks
 * the state of every checksum entry until all are `"ok"` or `"created"`.
 */
async function pollDifAssembly(params: {
  regionUrl: string;
  endpoint: string;
  body: unknown;
  checksums: string[];
}): Promise<void> {
  const { regionUrl, endpoint, body, checksums } = params;
  const deadline = Date.now() + ASSEMBLE_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ASSEMBLE_POLL_INTERVAL_MS));

    const { data: pollResult } = await apiRequestToRegion<DifAssembleResponse>(
      regionUrl,
      endpoint,
      {
        method: "POST",
        body,
        schema: DifAssembleResponseSchema,
      }
    );

    const { allDone } = checkAssembleResponse(pollResult, checksums, endpoint);
    if (allDone) {
      return;
    }
  }

  throw new ApiError(
    "ProGuard mapping assembly timed out",
    408,
    `Assembly did not complete within ${ASSEMBLE_MAX_WAIT_MS / 1000}s`,
    endpoint
  );
}
