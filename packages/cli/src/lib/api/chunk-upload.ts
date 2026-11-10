/**
 * Shared chunk-upload protocol infrastructure.
 *
 * Implements the Sentry chunk-upload + assemble protocol used by
 * artifact bundle (sourcemap) and DIF (proguard) uploads. Callers
 * build their own ZIP and choose the appropriate assemble endpoint;
 * this module handles chunking, hashing, codec selection, chunk
 * upload, and assembly polling.
 *
 * Protocol overview:
 * 1. GET  chunk-upload options (chunk size, concurrency, compression)
 * 2. (Caller builds the ZIP)
 * 3. Split ZIP into chunks, compute SHA-1 checksums
 * 4. POST assemble request -> server reports missing chunks
 * 5. Upload missing chunks in parallel as multipart/form-data
 * 6. Poll assemble endpoint until complete
 */

import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { promisify } from "node:util";
import {
  gzip as gzipCb,
  constants as zlibConstants,
  zstdCompress as zstdCompressCb,
} from "node:zlib";
import {
  type AssembleOrganizationArtifactBundleData,
  type AssembleProjectDebugFilesData,
  assembleOrganizationArtifactBundle,
  assembleProjectDebugFiles,
  getOrganizationChunkUploadOptions,
} from "@sentry/api";
import pLimit from "p-limit";
import {
  array,
  type InferOutput,
  nullish,
  number,
  object,
  optional,
  picklist,
  record,
  string,
} from "valibot";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import { getSdkConfig } from "../sentry-client.js";
import { getOrgSdkConfig, unwrapValidatedResult } from "./infrastructure.js";

const gzipAsync = promisify(gzipCb);
// zstdCompress exists only on Node.js 22.15+. On older runtimes (npm package
// on Node < 22.15) it's undefined, and promisify(undefined) throws at import
// time. Guard it and treat "no local zstd" as "don't advertise zstd" in
// selectUploadCodec below, so a zstd-capable server never picks a codec we
// can't produce.
const zstdCompressAsync =
  typeof zstdCompressCb === "function" ? promisify(zstdCompressCb) : null;
const log = logger.withTag("api.chunk-upload");

// ── Schemas ─────────────────────────────────────────────────────────

/** Server-provided chunk upload configuration. */
export const ChunkServerOptionsSchema = object({
  /** Absolute URL to upload chunks to. */
  url: string(),
  /** Maximum size of a single chunk in bytes. */
  chunkSize: number(),
  /** Maximum number of chunks per upload request. */
  chunksPerRequest: number(),
  /** Maximum total request body size in bytes. */
  maxRequestSize: number(),
  /**
   * Maximum size of a single uploaded file in bytes. Omitted or `0` means the
   * server advertises no per-file cap, in which case the client falls back to
   * {@link DEFAULT_MAX_DIF_SIZE}.
   */
  maxFileSize: optional(number()),
  /**
   * Maximum time, in seconds, the server is willing to spend assembling an
   * upload. Omitted or `0` means no server-imposed cap; a non-zero value clamps
   * the caller's requested wait. Mirrors the legacy `dif_upload` `max_wait`
   * semantics.
   */
  maxWait: optional(number()),
  /** Hash algorithm for chunk checksums (always "sha1"). */
  hashAlgorithm: string(),
  /** Maximum concurrent upload requests. */
  concurrency: number(),
  /** Supported compression methods (e.g., ["gzip"]). */
  compression: array(string()),
});

export type ChunkServerOptions = InferOutput<typeof ChunkServerOptionsSchema>;

/** Response from an assemble endpoint (shared by artifact bundle and DIF). */
export const AssembleResponseSchema = object({
  state: picklist(["not_found", "created", "assembling", "ok", "error"]),
  missingChunks: optional(array(string())),
  detail: nullish(string()),
});

export type AssembleResponse = InferOutput<typeof AssembleResponseSchema>;

/** Response from the DIF assemble endpoint, keyed by file checksum. */
const DifAssembleResponseSchema = record(string(), AssembleResponseSchema);

export type DifAssembleResponse = InferOutput<typeof DifAssembleResponseSchema>;

// ── Types ───────────────────────────────────────────────────────────

/** Chunk metadata after splitting the ZIP for upload. */
export type ChunkInfo = {
  /** SHA-1 checksum of this chunk. */
  sha1: string;
  /** Byte offset in the ZIP file. */
  offset: number;
  /** Byte size of this chunk. */
  size: number;
};

// ── Constants ───────────────────────────────────────────────────────

/** Interval between assemble poll requests. */
export const ASSEMBLE_POLL_INTERVAL_MS = 1000;

/** Maximum time to wait for assembly. */
export const ASSEMBLE_MAX_WAIT_MS = 300_000;

/**
 * Fallback per-file size cap (2 GiB) used when the server advertises no
 * `maxFileSize` (i.e. reports `0`). Matches the legacy `DEFAULT_MAX_DIF_SIZE`.
 */
export const DEFAULT_MAX_DIF_SIZE = 2 * 1024 * 1024 * 1024;

/**
 * Codecs the CLI knows how to emit, in order of preference.
 *
 * `zstd` is the forward-looking codec: advertised only by servers that
 * implement `Content-Encoding`-based detection. `gzip` is the legacy
 * codec supported by every Sentry server since forever; we still send
 * it under the original `file_gzip` multipart field name so that
 * pre-zstd servers -- which ignore `Content-Encoding` -- keep working.
 */
const UPLOAD_CODECS = ["zstd", "gzip"] as const;
export type UploadEncoding = (typeof UPLOAD_CODECS)[number];

// ── API Functions ───────────────────────────────────────────────────

/**
 * Get chunk upload configuration for an organization.
 *
 * @param orgSlug - Organization slug
 * @returns Server-provided upload options (chunk size, concurrency, etc.)
 */
export async function getChunkUploadOptions(
  orgSlug: string,
): Promise<ChunkServerOptions> {
  const config = getOrgSdkConfig();
  const result = await getOrganizationChunkUploadOptions({
    ...config,
    path: { organization_id_or_slug: orgSlug },
  });
  // The schema also reads `maxWait`, which the generated type lacks.
  const data = unwrapValidatedResult(
    result,
    "Failed to get chunk upload options",
    ChunkServerOptionsSchema,
    `organizations/${orgSlug}/chunk-upload/`,
  );

  // Self-hosted Sentry instances may return a chunk-upload URL that embeds
  // DSN credentials (e.g. https://<token>@host/...). Node.js 25+ rejects
  // constructing a fetch Request from such a URL per the Fetch spec. Strip
  // them here — auth is already handled by the authFetch wrapper.
  const parsedUrl = new URL(data.url);
  if (parsedUrl.username || parsedUrl.password) {
    parsedUrl.username = "";
    parsedUrl.password = "";
    return { ...data, url: parsedUrl.href };
  }

  return data;
}

/**
 * Select the most efficient upload codec the server advertises, or
 * `undefined` for plain (uncompressed) uploads when the server opts out
 * of compression (e.g. the `chunk-upload.no-compression` kill-switch)
 * or advertises only codecs we don't implement.
 *
 * Exported for testing.
 */
export function pickUploadEncoding(
  compression: string[],
): UploadEncoding | undefined {
  for (const codec of UPLOAD_CODECS) {
    // Skip zstd when the local runtime can't produce it (Node < 22.15).
    if (codec === "zstd" && !zstdCompressAsync) {
      continue;
    }
    if (compression.includes(codec)) {
      return codec;
    }
  }
  if (compression.length > 0) {
    log.debug(
      `server advertised unsupported codecs [${compression.join(", ")}]; falling back to plain upload`,
    );
  }
  return;
}

/**
 * Compress a chunk buffer with the chosen codec. Exported for testing.
 *
 * Both codecs run off-thread via libuv's thread pool, so a chunk
 * being compressed doesn't block the event loop --
 * with `concurrency=8`, eight uploads truly compress in parallel.
 */
export async function encodeChunk(
  buf: Buffer,
  encoding: UploadEncoding | undefined,
): Promise<Uint8Array> {
  if (encoding === "zstd") {
    // pickUploadEncoding never selects zstd when the runtime lacks it, so this
    // should be unreachable. Fail loudly rather than return raw bytes that the
    // caller would still tag `Content-Encoding: zstd` — that mislabel would
    // corrupt the upload on the server.
    if (!zstdCompressAsync) {
      throw new Error(
        "zstd encoding requested but unavailable on this runtime (Node < 22.15)",
      );
    }
    // L3 is libzstd's default; passed explicitly for self-documenting
    // code. L9+ trades ~14% size for 4x compress time and forces the
    // server's decoder to allocate 15-30 MiB of window state -- not
    // worth it once decode cost is counted.
    return await zstdCompressAsync(buf, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 },
    });
  }
  if (encoding === "gzip") {
    // zlib default (L6). Counter-intuitively, lower levels (L1/L5)
    // DEcompress SLOWER on the server (sparser Huffman codes); L9
    // costs ~2x the compress CPU for no meaningful size win.
    return await gzipAsync(buf);
  }
  return buf;
}

/**
 * Read a single chunk from the staging ZIP, compress it with the server's
 * preferred codec, and POST it to the chunk-upload endpoint.
 *
 * Wire format by codec (driven by {@link pickUploadEncoding}):
 *  - `zstd`  -> `Content-Encoding: zstd` + `file` multipart field.
 *               Only works against servers that opted in via
 *               `Content-Encoding` detection (getsentry/sentry#113760+).
 *  - `gzip`  -> LEGACY `file_gzip` multipart field, NO `Content-Encoding`
 *               header. Works with every server that advertises `gzip`,
 *               including pre-zstd self-hosted deployments.
 *  - plain   -> `file` multipart field, no `Content-Encoding`.
 *
 * NB: never emit `Content-Encoding: gzip` alongside the `file_gzip`
 * field -- zstd-aware servers reject that combination (400) to avoid
 * ambiguity.
 */
export async function uploadChunk(params: {
  chunk: ChunkInfo;
  tmpZipPath: string;
  encoding: UploadEncoding | undefined;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  url: string;
}): Promise<void> {
  const { chunk, tmpZipPath, encoding, fetch: authFetch, url } = params;

  const chunkFh = await open(tmpZipPath, "r");
  let buf: Buffer;
  try {
    buf = Buffer.alloc(chunk.size);
    await chunkFh.read(buf, 0, chunk.size, chunk.offset);
  } finally {
    await chunkFh.close();
  }

  const payload = await encodeChunk(buf, encoding);

  // gzip uses the legacy `file_gzip` field for backwards compatibility
  // with pre-zstd servers; zstd and plain use the standard `file` field.
  const fieldName = encoding === "gzip" ? "file_gzip" : "file";
  const form = new FormData();
  form.append(
    fieldName,
    new Blob([payload], { type: "application/octet-stream" }),
    chunk.sha1,
  );

  const init: RequestInit = { method: "POST", body: form };
  if (encoding === "zstd") {
    init.headers = { "Content-Encoding": "zstd" };
  }

  const response = await authFetch(url, init);
  if (!response.ok) {
    throw new ApiError(
      `Chunk upload failed: ${response.status} ${response.statusText}`,
      response.status,
      await response.text().catch(() => ""),
      url,
    );
  }
}

/**
 * Split a ZIP file into chunks and compute SHA-1 checksums.
 *
 * Reads the file sequentially — only one chunk buffer is live at a time.
 *
 * @param zipPath - Path to the ZIP file
 * @param chunkSize - Size of each chunk in bytes
 * @returns Per-chunk metadata and an overall SHA-1 checksum of the entire file
 */
export async function hashChunks(
  zipPath: string,
  chunkSize: number,
): Promise<{ chunks: ChunkInfo[]; overallChecksum: string }> {
  const fh = await open(zipPath, "r");
  try {
    const fileSize = (await stat(zipPath)).size;
    const chunks: ChunkInfo[] = [];
    const overallHasher = createHash("sha1");

    for (let offset = 0; offset < fileSize; offset += chunkSize) {
      const size = Math.min(chunkSize, fileSize - offset);
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, offset);
      const sha1 = createHash("sha1").update(buf).digest("hex");
      overallHasher.update(buf);
      chunks.push({ sha1, offset, size });
    }

    return { chunks, overallChecksum: overallHasher.digest("hex") };
  } finally {
    await fh.close();
  }
}

/**
 * Split an in-memory buffer into chunks and compute SHA-1 checksums.
 *
 * Same as {@link hashChunks} but operates on a `Buffer` instead of a file,
 * used by DIF uploads (e.g. ProGuard) where the raw bytes are chunked
 * directly without wrapping in a ZIP.
 *
 * @param content - Raw file content
 * @param chunkSize - Size of each chunk in bytes
 * @returns Per-chunk metadata and an overall SHA-1 checksum of the entire buffer
 */
export function hashBuffer(
  content: Buffer,
  chunkSize: number,
): { chunks: ChunkInfo[]; overallChecksum: string } {
  const chunks: ChunkInfo[] = [];
  const overallHasher = createHash("sha1");

  for (let offset = 0; offset < content.length; offset += chunkSize) {
    const size = Math.min(chunkSize, content.length - offset);
    const buf = content.subarray(offset, offset + size);
    const sha1 = createHash("sha1").update(buf).digest("hex");
    overallHasher.update(buf);
    chunks.push({ sha1, offset, size });
  }

  return { chunks, overallChecksum: overallHasher.digest("hex") };
}

/**
 * Upload chunks the server reports as missing, in parallel.
 *
 * Filters the full chunk list against the set of missing checksums,
 * then uploads each missing chunk concurrently up to the server's
 * advertised concurrency limit.
 *
 * @param params.chunks - All chunks from {@link hashChunks}
 * @param params.missingChecksums - SHA-1 checksums the server needs
 * @param params.tmpZipPath - Path to the ZIP file on disk
 * @param params.serverOptions - Chunk upload config from server
 * @param params.encoding - Wire codec (zstd/gzip/undefined)
 * @param params.regionUrl - Region base URL for authenticated fetch
 */
export async function uploadMissingChunks(params: {
  chunks: ChunkInfo[];
  missingChecksums: Set<string>;
  tmpZipPath: string;
  serverOptions: ChunkServerOptions;
  encoding: UploadEncoding | undefined;
  regionUrl: string;
}): Promise<void> {
  const {
    chunks,
    missingChecksums,
    tmpZipPath,
    serverOptions,
    encoding,
    regionUrl,
  } = params;
  const missingChunks = chunks.filter((c) => missingChecksums.has(c.sha1));

  if (missingChunks.length === 0) {
    return;
  }

  const limit = pLimit(serverOptions.concurrency);
  // Chunks are stored by SHA-1, so a replayed upload is a no-op. Opt in
  // explicitly: the server-provided URL need not match the catalog path.
  const { fetch: authFetch } = getSdkConfig(regionUrl, { idempotent: true });

  await Promise.all(
    missingChunks.map((chunk) =>
      limit(() =>
        uploadChunk({
          chunk,
          tmpZipPath,
          encoding,
          fetch: authFetch,
          url: serverOptions.url,
        }),
      ),
    ),
  );
}

/**
 * Upload a single chunk from an in-memory buffer, compress it, and POST.
 *
 * Same wire format as {@link uploadChunk} but reads from a buffer
 * instead of a file handle.
 */
/** One chunk's bytes, keyed by its checksum, ready to upload. */
export type ChunkPayload = {
  sha1: string;
  data: Buffer;
};

/**
 * Group chunks into upload requests of at most `chunksPerRequest` chunks and
 * `maxRequestSize` bytes (a chunk larger than the cap still travels alone).
 * Debug file sets can hold tens of thousands of small files, so one request
 * per chunk would take minutes; the server accepts repeated `file` fields.
 */
export function batchChunkPayloads(
  chunks: readonly ChunkPayload[],
  serverOptions: Pick<
    ChunkServerOptions,
    "chunksPerRequest" | "maxRequestSize"
  >,
): ChunkPayload[][] {
  const maxChunks = Math.max(1, serverOptions.chunksPerRequest);
  const maxBytes = Math.max(1, serverOptions.maxRequestSize);
  const batches: ChunkPayload[][] = [];
  let batch: ChunkPayload[] = [];
  let bytes = 0;
  for (const chunk of chunks) {
    if (
      batch.length > 0 &&
      (batch.length >= maxChunks || bytes + chunk.data.length > maxBytes)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(chunk);
    bytes += chunk.data.length;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

/** POST one batch of chunks as a multipart request, one field per chunk. */
async function uploadChunkBatch(params: {
  batch: readonly ChunkPayload[];
  encoding: UploadEncoding | undefined;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  url: string;
}): Promise<void> {
  const { batch, encoding, fetch: authFetch, url } = params;

  const fieldName = encoding === "gzip" ? "file_gzip" : "file";
  const form = new FormData();
  for (const chunk of batch) {
    const payload = await encodeChunk(chunk.data, encoding);
    form.append(
      fieldName,
      new Blob([payload], { type: "application/octet-stream" }),
      chunk.sha1,
    );
  }

  const init: RequestInit = { method: "POST", body: form };
  if (encoding === "zstd") {
    init.headers = { "Content-Encoding": "zstd" };
  }

  const response = await authFetch(url, init);
  if (!response.ok) {
    throw new ApiError(
      `Chunk upload failed: ${response.status} ${response.statusText}`,
      response.status,
      await response.text().catch((err) => {
        log.debug("Failed to read chunk upload error response body", err);
        return "";
      }),
      url,
    );
  }
}

/**
 * Upload chunks in batched requests (see {@link batchChunkPayloads}), with
 * `concurrency` requests in flight at once.
 */
export async function uploadChunkPayloads(params: {
  chunks: readonly ChunkPayload[];
  serverOptions: ChunkServerOptions;
  encoding: UploadEncoding | undefined;
  regionUrl: string;
}): Promise<void> {
  const { chunks, serverOptions, encoding, regionUrl } = params;
  if (chunks.length === 0) {
    return;
  }

  const limit = pLimit(serverOptions.concurrency);
  // Chunks are stored by SHA-1, so a replayed upload is a no-op. Opt in
  // explicitly: the server-provided URL need not match the catalog path.
  const { fetch: authFetch } = getSdkConfig(regionUrl, { idempotent: true });

  await Promise.all(
    batchChunkPayloads(chunks, serverOptions).map((batch) =>
      limit(() =>
        uploadChunkBatch({
          batch,
          encoding,
          fetch: authFetch,
          url: serverOptions.url,
        }),
      ),
    ),
  );
}

/**
 * Upload missing chunks from an in-memory buffer, in parallel.
 *
 * Same as {@link uploadMissingChunks} but reads chunk data from a buffer
 * instead of a file. Used by DIF uploads (e.g. ProGuard) where raw bytes
 * are chunked directly without wrapping in a ZIP.
 */
export async function uploadMissingBufferChunks(params: {
  chunks: ChunkInfo[];
  missingChecksums: Set<string>;
  content: Buffer;
  serverOptions: ChunkServerOptions;
  encoding: UploadEncoding | undefined;
  regionUrl: string;
}): Promise<void> {
  const {
    chunks,
    missingChecksums,
    content,
    serverOptions,
    encoding,
    regionUrl,
  } = params;
  await uploadChunkPayloads({
    chunks: chunks
      .filter((c) => missingChecksums.has(c.sha1))
      .map((c) => ({
        sha1: c.sha1,
        data: content.subarray(c.offset, c.offset + c.size),
      })),
    serverOptions,
    encoding,
    regionUrl,
  });
}

/**
 * Request DIF assembly for one batch of files.
 *
 * The server answers with one entry per file checksum in the body. Sending the
 * same body again polls the assembly state.
 *
 * @param org - Organization slug
 * @param project - Project slug
 * @param body - Files to assemble, keyed by overall checksum
 */
export async function assembleDebugFiles(
  org: string,
  project: string,
  body: NonNullable<AssembleProjectDebugFilesData["body"]>,
): Promise<DifAssembleResponse> {
  const config = getOrgSdkConfig();
  const result = await assembleProjectDebugFiles({
    ...config,
    path: { organization_id_or_slug: org, project_id_or_slug: project },
    body,
  });
  return unwrapValidatedResult(
    result,
    "Failed to assemble debug files",
    DifAssembleResponseSchema,
    `projects/${org}/${project}/files/difs/assemble/`,
  );
}

/**
 * Request assembly of an artifact bundle. Sending the same body again polls
 * the assembly state.
 *
 * @param org - Organization slug
 * @param body - Bundle checksum, chunk checksums, projects and release
 */
export async function assembleArtifactBundle(
  org: string,
  body: NonNullable<AssembleOrganizationArtifactBundleData["body"]>,
): Promise<AssembleResponse> {
  const config = getOrgSdkConfig();
  const result = await assembleOrganizationArtifactBundle({
    ...config,
    path: { organization_id_or_slug: org },
    body,
  });
  return unwrapValidatedResult(
    result,
    "Failed to assemble artifact bundle",
    AssembleResponseSchema,
    `organizations/${org}/artifactbundle/assemble/`,
  );
}

/**
 * Poll an assemble request until the server reports completion.
 *
 * `assemble` re-sends the same assemble body on each poll (the server uses
 * the checksum to look up existing assembly state). By default returns when
 * the state is `"ok"` or `"created"`; set `waitForOk` to block until the server
 * finishes processing (`"ok"` only). Throws on `"error"` or timeout.
 *
 * @param params.assemble - Sends the assemble request and returns its state
 * @param params.endpoint - The assemble endpoint path, for error messages
 * @param params.entityName - Human-readable name for error messages
 * @param params.waitForOk - Keep polling on `"created"`, returning only on `"ok"`
 * @param params.deadlineMs - Override the default poll timeout window
 */
export async function pollAssembly(params: {
  assemble: () => Promise<AssembleResponse>;
  endpoint: string;
  entityName: string;
  waitForOk?: boolean;
  deadlineMs?: number;
}): Promise<void> {
  const {
    assemble,
    endpoint,
    entityName,
    waitForOk = false,
    deadlineMs = ASSEMBLE_MAX_WAIT_MS,
  } = params;
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ASSEMBLE_POLL_INTERVAL_MS));

    const pollResult = await assemble();

    if (pollResult.state === "ok") {
      return;
    }

    // When not waiting for full processing, an accepted ("created") bundle is
    // sufficient; otherwise keep polling until it flips to "ok".
    if (pollResult.state === "created" && !waitForOk) {
      return;
    }

    if (pollResult.state === "error") {
      throw new ApiError(
        `${entityName} assembly failed`,
        500,
        pollResult.detail ?? "Unknown error",
        endpoint,
      );
    }
    // "not_found", "assembling", or ("created" while waiting) — keep polling
  }

  throw new ApiError(
    `${entityName} assembly timed out`,
    408,
    `Assembly did not complete within ${deadlineMs / 1000}s`,
    endpoint,
  );
}
