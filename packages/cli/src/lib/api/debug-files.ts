/**
 * Debug Information File (DIF) Upload API
 *
 * Uploads native debug information files (Mach-O/dSYM, ELF, PE/PDB, Portable
 * PDB, WASM, Breakpad, source bundles) via the DIF chunk-upload + assemble
 * protocol shared with ProGuard and Dart symbol-map uploads.
 *
 * Protocol: each file's raw bytes are chunked directly (no ZIP wrapping) and
 * assembled through `projects/{org}/{project}/files/difs/assemble/`. The body
 * keys each file by its overall SHA-1 checksum, with `name`, optional
 * `debug_id`, and the per-chunk checksum list. Multiple files are batched into
 * a single assemble request, like ProGuard.
 *
 * Two completion modes (see {@link uploadDebugFiles}):
 *  - **no-wait** (default): stop once the server holds every chunk of every
 *    file. Server-side processing errors are not surfaced.
 *  - **wait**: poll until every file reaches a terminal state (`ok`/`error`),
 *    collecting `error` details so the caller can report and exit non-zero.
 */

import { type InferOutput, record, string } from "valibot";
import { ApiError, ValidationError } from "../errors.js";
import { logger } from "../logger.js";
import { resolveOrgRegion } from "../region.js";
import {
  ASSEMBLE_MAX_WAIT_MS,
  ASSEMBLE_POLL_INTERVAL_MS,
  type AssembleResponse,
  AssembleResponseSchema,
  type ChunkInfo,
  type ChunkServerOptions,
  DEFAULT_MAX_DIF_SIZE,
  getChunkUploadOptions,
  hashBuffer,
  pickUploadEncoding,
  type UploadEncoding,
  uploadMissingBufferChunks,
} from "./chunk-upload.js";
import { apiRequestToRegion } from "./infrastructure.js";

const log = logger.withTag("api.debug-files");

// ── Types ───────────────────────────────────────────────────────────

/** A single debug information file to upload. */
export type DebugFileUpload = {
  /** Name stamped on the assembled DIF (typically the input file's basename). */
  name: string;
  /**
   * Advisory debug id for the file's primary object. The server re-parses the
   * uploaded bytes and indexes every contained slice itself, so this is
   * `skip_serializing_if none` in the wire format — omitted when absent.
   */
  debugId?: string;
  /** Pre-read raw file content (chunked as-is). */
  content: Buffer;
};

/** Options for {@link uploadDebugFiles}. */
export type DebugFilesUploadOptions = {
  /** Organization slug. */
  org: string;
  /** Project slug. */
  project: string;
  /** Debug information files to upload. */
  difs: DebugFileUpload[];
  /**
   * When `true`, poll until every file reaches a terminal state (`ok`/`error`)
   * and surface processing errors. When `false`, return as soon as the server
   * holds every chunk (no server-side processing wait).
   */
  wait: boolean;
  /** Maximum time to wait for assembly/processing, in milliseconds. */
  maxWaitMs: number;
  /**
   * Pre-fetched chunk-upload server options. When provided, the internal
   * `getChunkUploadOptions` call is skipped (the caller already fetched them,
   * e.g. to size-gate the scan against the server's `maxFileSize`).
   */
  serverOptions?: ChunkServerOptions;
};

/** Per-file result of a debug information file upload. */
export type DebugFileUploadResult = {
  /** Name stamped on the assembled DIF. */
  name: string;
  /** Advisory debug id, if one was provided. */
  debugId?: string;
  /** Overall SHA-1 checksum of the uploaded file. */
  checksum: string;
  /**
   * Terminal (or last-observed) assembly state. In no-wait mode this is often
   * `created`/`assembling` because processing has not finished.
   */
  state: AssembleResponse["state"];
  /** Server-provided detail/error message, if any. */
  detail: string | null;
};

// ── Schemas ─────────────────────────────────────────────────────────

/**
 * DIF assemble response — keyed by overall checksum, each value has the same
 * shape as the standard assemble response.
 */
const DifAssembleResponseSchema = record(string(), AssembleResponseSchema);

type DifAssembleResponse = InferOutput<typeof DifAssembleResponseSchema>;

// ── Internal types ──────────────────────────────────────────────────

/** Per-file chunk metadata computed before the assemble request. */
type ChunkedDif = {
  /** The file being uploaded. */
  dif: DebugFileUpload;
  /** Per-chunk SHA-1 checksums and offsets. */
  chunks: ChunkInfo[];
  /** SHA-1 of the entire file. */
  overallChecksum: string;
};

/** Outcome of evaluating an assemble response against the desired stop mode. */
type AssembleEvaluation = {
  /**
   * Whether the upload is complete for the active mode: in wait mode every
   * file is terminal (`ok`/`error`); in no-wait mode the server holds every
   * chunk of every file.
   */
  done: boolean;
  /** SHA-1 checksums the server still needs uploaded. */
  missingChecksums: Set<string>;
};

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Build the assemble request body — one entry per file, keyed by checksum.
 *
 * `debug_id` is only included when present (matches the legacy
 * `skip_serializing_if none` behavior).
 */
function buildAssembleBody(
  chunked: ChunkedDif[]
): Record<string, { name: string; debug_id?: string; chunks: string[] }> {
  const body: Record<
    string,
    { name: string; debug_id?: string; chunks: string[] }
  > = {};
  for (const cd of chunked) {
    body[cd.overallChecksum] = {
      name: cd.dif.name,
      ...(cd.dif.debugId ? { debug_id: cd.dif.debugId } : {}),
      chunks: cd.chunks.map((c) => c.sha1),
    };
  }
  return body;
}

/**
 * Evaluate an assemble response for completion and outstanding chunks.
 *
 * A file's chunks are "held" by the server once its entry exists, is not in the
 * `not_found` state, and reports no missing chunks. A file is "terminal" once
 * its state is `ok` or `error`. Unlike ProGuard/Dart uploads, an `error` entry
 * is NOT thrown here — it is a terminal state collected for reporting so the
 * caller can decide the exit code.
 *
 * When a file's entry is missing from the response, all of that file's chunks
 * are treated as missing — the server has no record of receiving them, so we
 * must (re-)send. This guards against an upload loop stalling on a phantom
 * "missing nothing" file that the server has never seen.
 *
 * @param response - The assemble response keyed by checksum.
 * @param chunked - The per-file chunk metadata, in input order.
 * @param wait - When `true`, completion requires every file to be terminal.
 */
function evaluateAssembly(
  response: DifAssembleResponse,
  chunked: ChunkedDif[],
  wait: boolean
): AssembleEvaluation {
  const missingChecksums = new Set<string>();
  let allHeld = true;
  let allTerminal = true;

  for (const cd of chunked) {
    const result = classifyEntry(response[cd.overallChecksum], cd);
    if (!result.held) {
      allHeld = false;
    }
    if (!result.terminal) {
      allTerminal = false;
    }
    for (const sha1 of result.missing) {
      missingChecksums.add(sha1);
    }
  }

  return { done: wait ? allTerminal : allHeld, missingChecksums };
}

/**
 * Classify a single file's assemble response.
 *
 * Returns whether the server holds every chunk (`held`), whether the file is
 * in a terminal state (`terminal`), and the chunk checksums that still need
 * to be uploaded (`missing`). A missing entry is treated as "no chunks held"
 * — the server has no record of the file, so every chunk must be (re-)sent.
 */
function classifyEntry(
  entry: AssembleResponse | undefined,
  cd: ChunkedDif
): { held: boolean; terminal: boolean; missing: string[] } {
  if (!entry) {
    return {
      held: false,
      terminal: false,
      missing: cd.chunks.map((c) => c.sha1),
    };
  }

  if (entry.state === "not_found") {
    // Server has no record of this file. Re-send every chunk rather than
    // trusting the (possibly absent) `missingChunks` field — an empty list
    // here would otherwise leave the upload loop polling forever.
    return {
      held: false,
      terminal: false,
      missing: cd.chunks.map((c) => c.sha1),
    };
  }

  const missing = entry.missingChunks ?? [];
  if (missing.length > 0) {
    return { held: false, terminal: false, missing };
  }

  // Entry exists, server holds every chunk. `created`/`assembling` are
  // held-but-not-terminal; `ok`/`error` are terminal.
  const terminal = entry.state === "ok" || entry.state === "error";
  return { held: true, terminal, missing: [] };
}

/** Upload any chunks the server reported missing, across all files. */
async function uploadMissing(params: {
  chunked: ChunkedDif[];
  missingChecksums: Set<string>;
  serverOptions: ChunkServerOptions;
  encoding: UploadEncoding | undefined;
  regionUrl: string;
}): Promise<void> {
  const { chunked, missingChecksums, serverOptions, encoding, regionUrl } =
    params;
  if (missingChecksums.size === 0) {
    return;
  }
  for (const cd of chunked) {
    await uploadMissingBufferChunks({
      chunks: cd.chunks,
      missingChecksums,
      content: cd.dif.content,
      serverOptions,
      encoding,
      regionUrl,
    });
  }
}

/** POST the assemble request and parse the keyed response. */
async function postAssemble(
  regionUrl: string,
  endpoint: string,
  body: unknown
): Promise<DifAssembleResponse> {
  const { data } = await apiRequestToRegion<DifAssembleResponse>(
    regionUrl,
    endpoint,
    { method: "POST", body, schema: DifAssembleResponseSchema }
  );
  return data;
}

/** Build per-file results from the last-observed assemble response. */
function buildResults(
  chunked: ChunkedDif[],
  response: DifAssembleResponse
): DebugFileUploadResult[] {
  return chunked.map((cd) => {
    const entry = response[cd.overallChecksum];
    return {
      name: cd.dif.name,
      debugId: cd.dif.debugId,
      checksum: cd.overallChecksum,
      state: entry?.state ?? "not_found",
      detail: entry?.detail ?? null,
    };
  });
}

// ── API Functions ───────────────────────────────────────────────────

/**
 * Split files into those within the server-advertised per-file cap and those
 * over it.
 *
 * @param difs - Files queued for upload.
 * @param maxFileSize - Server's per-file byte cap; `0` disables the gate.
 * @returns `{ accepted, dropped }`. Oversized files are logged at `warn` and
 *   returned in `dropped` so the caller can report them as failures rather
 *   than silently discarding them.
 */
function filterBySize(
  difs: DebugFileUpload[],
  maxFileSize: number
): { accepted: DebugFileUpload[]; dropped: DebugFileUpload[] } {
  if (maxFileSize <= 0) {
    return { accepted: difs, dropped: [] };
  }
  const accepted: DebugFileUpload[] = [];
  const dropped: DebugFileUpload[] = [];
  for (const dif of difs) {
    if (dif.content.length > maxFileSize) {
      log.warn(
        `Skipping ${dif.name}: size ${dif.content.length} exceeds server maximum file size ${maxFileSize}`
      );
      dropped.push(dif);
      continue;
    }
    accepted.push(dif);
  }
  return { accepted, dropped };
}

/**
 * Build failed result entries for files dropped by the size gate.
 *
 * Oversized files are never chunked or assembled, so the server never returns a
 * state for them. They are reported as `error` results — not silently skipped —
 * so the command surfaces a non-zero exit and lists them. A partial size-drop
 * (some files accepted, some over the cap) must not look like a clean success,
 * mirroring the all-dropped case which throws.
 *
 * @param dropped - Files that exceeded `maxFileSize`.
 * @param maxFileSize - The effective per-file cap, for the detail message.
 * @returns One `error` result per dropped file (empty `checksum`, never hashed).
 */
function buildOversizeResults(
  dropped: DebugFileUpload[],
  maxFileSize: number
): DebugFileUploadResult[] {
  return dropped.map((dif) => ({
    name: dif.name,
    debugId: dif.debugId,
    checksum: "",
    state: "error" as const,
    detail: `Exceeds server maximum file size of ${maxFileSize} bytes (was ${dif.content.length} bytes)`,
  }));
}

/**
 * Clamp the caller's requested wait to the server's advertised maximum.
 *
 * @param requestedMs - The caller's requested wait in milliseconds.
 * @param serverMaxWaitSec - Server's max wait in seconds; `0` means no cap.
 * @returns The effective wait in milliseconds.
 */
function clampMaxWait(requestedMs: number, serverMaxWaitSec: number): number {
  if (serverMaxWaitSec <= 0) {
    return requestedMs;
  }
  const serverMaxMs = serverMaxWaitSec * 1000;
  if (serverMaxMs < requestedMs) {
    log.debug(
      `Clamping assembly wait from ${requestedMs}ms to server maximum ${serverMaxMs}ms`
    );
    return serverMaxMs;
  }
  return requestedMs;
}

/**
 * Upload debug information files to Sentry via the DIF chunk-upload protocol.
 *
 * Each file's raw bytes are chunked directly (no ZIP wrapping) and all files
 * are batched into a single assemble request keyed by overall SHA-1 checksum.
 * The server re-parses each uploaded file and indexes every contained object
 * slice itself; `debugId` is advisory.
 *
 * Files larger than the server-advertised `maxFileSize` are not uploaded and
 * are returned as `error` results (so a partial drop yields a non-zero exit
 * rather than a misleading success); the caller's `maxWaitMs` is clamped to the
 * server's `maxWait`.
 *
 * @param options - Upload configuration (org, project, files, wait mode).
 * @returns Per-file terminal/last-observed assembly state.
 * @throws {ApiError} If chunk upload fails, or (wait mode only) assembly does
 *   not complete within the effective (clamped) wait.
 */
export async function uploadDebugFiles(
  options: DebugFilesUploadOptions
): Promise<DebugFileUploadResult[]> {
  const { org, project, difs, wait, maxWaitMs } = options;

  if (difs.length === 0) {
    return [];
  }

  const serverOptions =
    options.serverOptions ?? (await getChunkUploadOptions(org));
  const encoding = pickUploadEncoding(serverOptions.compression);

  // Honor the per-file cap. Use the server-advertised `maxFileSize`, falling
  // back to `DEFAULT_MAX_DIF_SIZE` when the server omits it (`0`) — the same
  // fallback the scan gate uses, so in-memory `--include-sources` bundles
  // (which bypass the scan gate) are still capped here.
  const effectiveMaxFileSize =
    serverOptions.maxFileSize && serverOptions.maxFileSize > 0
      ? serverOptions.maxFileSize
      : DEFAULT_MAX_DIF_SIZE;
  const { accepted, dropped } = filterBySize(difs, effectiveMaxFileSize);

  // `difs` is non-empty (checked above), so an empty `accepted` means every
  // file was dropped by the size gate. Fail loudly instead of silently
  // reporting success with nothing uploaded.
  if (accepted.length === 0) {
    throw new ValidationError(
      `All ${difs.length} debug file(s) exceed the maximum file size ` +
        `(${effectiveMaxFileSize} bytes). Nothing was uploaded.`,
      "file"
    );
  }

  const chunked: ChunkedDif[] = accepted.map((dif) => {
    const { chunks, overallChecksum } = hashBuffer(
      dif.content,
      serverOptions.chunkSize
    );
    return { dif, chunks, overallChecksum };
  });

  const regionUrl = await resolveOrgRegion(org);
  const endpoint = `projects/${org}/${project}/files/difs/assemble/`;
  const body = buildAssembleBody(chunked);

  // Clamp the caller's requested wait to the server's advertised maximum.
  // Only in wait mode — in no-wait mode `maxWaitMs` is purely a hang guard for
  // the chunk-delivery loop, not a processing budget, so it is left untouched.
  const effectiveMaxWaitMs = wait
    ? clampMaxWait(maxWaitMs, serverOptions.maxWait ?? 0)
    : maxWaitMs;
  const deadline = Date.now() + effectiveMaxWaitMs;
  let response = await postAssemble(regionUrl, endpoint, body);
  let evaluation = evaluateAssembly(response, chunked, wait);
  await uploadMissing({
    chunked,
    missingChecksums: evaluation.missingChecksums,
    serverOptions,
    encoding,
    regionUrl,
  });

  while (!evaluation.done) {
    if (Date.now() >= deadline) {
      if (wait) {
        throw new ApiError(
          "Debug file assembly timed out",
          408,
          `Assembly did not complete within ${Math.round(effectiveMaxWaitMs / 1000)}s`,
          endpoint
        );
      }
      // No-wait mode: the server kept reporting missing chunks past the
      // deadline. Stop and report the last-observed state rather than hang.
      log.warn(
        "Chunk delivery did not settle before the deadline — some files may not have been fully uploaded"
      );
      break;
    }

    await new Promise((r) => setTimeout(r, ASSEMBLE_POLL_INTERVAL_MS));
    response = await postAssemble(regionUrl, endpoint, body);
    evaluation = evaluateAssembly(response, chunked, wait);
    await uploadMissing({
      chunked,
      missingChecksums: evaluation.missingChecksums,
      serverOptions,
      encoding,
      regionUrl,
    });
  }

  // Append oversized files (dropped before assembly) as failed results so a
  // partial size-drop produces a non-zero exit instead of a silent success.
  return [
    ...buildResults(chunked, response),
    ...buildOversizeResults(dropped, effectiveMaxFileSize),
  ];
}

/** Default maximum wait for server-side DIF processing (`--wait`). */
export const DEBUG_FILES_MAX_WAIT_MS = ASSEMBLE_MAX_WAIT_MS;
