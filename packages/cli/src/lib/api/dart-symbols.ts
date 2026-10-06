/**
 * Dart Symbol Map DIF Upload API
 *
 * Uploads Dart/Flutter obfuscation maps via the DIF chunk-upload + assemble
 * protocol. Each mapping file is chunked as raw bytes and assembled through
 * the DIF endpoint with an externally-provided debug ID.
 *
 * Protocol: identical to ProGuard DIF uploads — raw bytes chunked directly
 * (no ZIP), assembled via `projects/{org}/{project}/files/difs/assemble/`.
 * The `debug_id` field in the assemble body links the map to a native
 * debug file (dSYM/ELF).
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

const log = logger.withTag("api.dart-symbols");

// Types

/** A single dart symbol map file to upload. */
export type DartSymbolMap = {
  /** Filesystem path (for display/logging). */
  path: string;
  /** The debug ID to associate with this map. */
  debugId: string;
  /** Pre-read content buffer. */
  content: Buffer;
};

/** Options for {@link uploadDartSymbolMap}. */
export type DartSymbolMapUploadOptions = {
  /** Organization slug. */
  org: string;
  /** Project slug. */
  project: string;
  /** The mapping file to upload. */
  mapping: DartSymbolMap;
};

// Schemas

/**
 * DIF assemble response — keyed by overall checksum, each value has
 * the same shape as the standard assemble response.
 */
const DifAssembleResponseSchema = record(string(), AssembleResponseSchema);

type DifAssembleResponse = InferOutput<typeof DifAssembleResponseSchema>;

// Helpers

/** Result of checking a DIF assemble response. */
type AssembleCheckResult = {
  /** True when the entry is `"ok"` or `"created"`. */
  allDone: boolean;
  /** SHA-1 checksums the server still needs uploaded. */
  missingChecksums: Set<string>;
};

/**
 * Check a DIF assemble response for completion, errors, and missing chunks.
 *
 * @throws {ApiError} If the entry reports an `"error"` state.
 */
function checkAssembleResponse(
  response: DifAssembleResponse,
  checksum: string,
  endpoint: string
): AssembleCheckResult {
  const missingChecksums = new Set<string>();
  const entry: AssembleResponse | undefined = response[checksum];

  if (!entry) {
    log.debug(`No assemble response for checksum ${checksum}`);
    return { allDone: false, missingChecksums };
  }

  if (entry.state === "error") {
    throw new ApiError(
      "Dart symbol map assembly failed",
      500,
      entry.detail ?? "Unknown error",
      endpoint
    );
  }

  if (entry.state === "ok" || entry.state === "created") {
    return { allDone: true, missingChecksums };
  }

  for (const sha1 of entry.missingChunks ?? []) {
    missingChecksums.add(sha1);
  }

  return { allDone: false, missingChecksums };
}

// API Function

/**
 * Upload a dart symbol map to Sentry via the DIF chunk-upload protocol.
 *
 * The mapping's raw bytes are chunked directly (no ZIP wrapping) and
 * assembled through the DIF endpoint with the provided debug ID.
 *
 * @param options - Upload configuration
 * @throws {ApiError} If the upload or assembly fails
 */
export async function uploadDartSymbolMap(
  options: DartSymbolMapUploadOptions
): Promise<void> {
  const { org, project, mapping } = options;

  // Step 1: Get chunk upload configuration
  const serverOptions = await getChunkUploadOptions(org);
  const encoding = pickUploadEncoding(serverOptions.compression);

  // Step 2: Hash the mapping file into chunks
  const { chunks, overallChecksum } = hashBuffer(
    mapping.content,
    serverOptions.chunkSize
  );

  const regionUrl = await resolveOrgRegion(org);
  const assembleEndpoint = `projects/${org}/${project}/files/difs/assemble/`;

  // Step 3: Build assemble body with debug_id
  const assembleBody: Record<
    string,
    { name: string; debug_id: string; chunks: string[] }
  > = {
    [overallChecksum]: {
      name: mapping.path,
      debug_id: mapping.debugId,
      chunks: chunks.map((c: ChunkInfo) => c.sha1),
    },
  };

  // Step 4: Request DIF assembly
  const { data: firstAssemble } = await apiRequestToRegion<DifAssembleResponse>(
    regionUrl,
    assembleEndpoint,
    {
      method: "POST",
      body: assembleBody,
      schema: DifAssembleResponseSchema,
    }
  );

  const { allDone, missingChecksums } = checkAssembleResponse(
    firstAssemble,
    overallChecksum,
    assembleEndpoint
  );

  if (allDone) {
    return;
  }

  // Step 5: Upload missing chunks
  await uploadMissingBufferChunks({
    chunks,
    missingChecksums,
    content: mapping.content,
    serverOptions,
    encoding,
    regionUrl,
  });

  // Step 6: Poll assemble endpoint until done
  const deadline = Date.now() + ASSEMBLE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ASSEMBLE_POLL_INTERVAL_MS));

    const { data: pollResult } = await apiRequestToRegion<DifAssembleResponse>(
      regionUrl,
      assembleEndpoint,
      {
        method: "POST",
        body: assembleBody,
        schema: DifAssembleResponseSchema,
      }
    );

    const { allDone: done } = checkAssembleResponse(
      pollResult,
      overallChecksum,
      assembleEndpoint
    );

    if (done) {
      return;
    }
  }

  throw new ApiError(
    "Dart symbol map assembly timed out",
    408,
    `Assembly did not complete within ${ASSEMBLE_MAX_WAIT_MS / 1000}s`,
    assembleEndpoint
  );
}
