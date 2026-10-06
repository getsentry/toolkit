/**
 * Sourcemap Upload API
 *
 * Implements artifact bundle building and upload for sourcemaps.
 * The underlying chunk-upload protocol (chunking, hashing, codec
 * selection, chunk upload, assembly polling) lives in
 * {@link ./chunk-upload.ts} and is shared with other upload flows
 * (e.g. ProGuard DIF uploads).
 *
 * Protocol overview:
 * 1. GET  chunk-upload options (chunk size, concurrency, compression)
 * 2. Build artifact bundle ZIP (streaming to disk via {@link ZipWriter})
 * 3. Split ZIP into chunks, compute SHA-1 checksums
 * 4. POST assemble request → server reports missing chunks
 * 5. Upload missing chunks in parallel as multipart/form-data
 * 6. Poll assemble endpoint until complete
 */

import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, ValidationError } from "../errors.js";
import { resolveOrgRegion } from "../region.js";
import { type ZipCompression, ZipWriter } from "../sourcemap/zip.js";
import {
  type AssembleResponse,
  AssembleResponseSchema,
  type ChunkInfo,
  type ChunkServerOptions,
  getChunkUploadOptions,
  hashChunks,
  pickUploadEncoding,
  pollAssembly,
  type UploadEncoding,
  uploadMissingChunks,
} from "./chunk-upload.js";
import { apiRequestToRegion } from "./infrastructure.js";

// ── Re-exports for backward compatibility ───────────────────────────
// These were originally defined in this module. External consumers
// (commands, tests) may still import them from here.
// biome-ignore lint/performance/noBarrelFile: backward-compat re-exports, not a barrel
export {
  type AssembleResponse,
  AssembleResponseSchema,
  type ChunkServerOptions,
  ChunkServerOptionsSchema,
  encodeChunk,
  getChunkUploadOptions,
  hashChunks,
  pickUploadEncoding,
  type UploadEncoding,
} from "./chunk-upload.js";

// ── Types ───────────────────────────────────────────────────────────

/** A source file to include in the artifact bundle. */
export type ArtifactFile = {
  /**
   * Filesystem path to the file. Read from disk unless {@link ArtifactFile.content}
   * is set; for inline sourcemaps (which have no `.map` file) this is
   * informational only.
   */
  path: string;
  /**
   * In-memory file content. When set, {@link buildArtifactBundle} uses this
   * instead of reading from `path`. Used for inline sourcemaps that have no
   * standalone `.map` file on disk.
   */
  content?: Buffer;
  /** Debug ID injected into this file (from {@link injectDebugId}). Omitted when uploading without rewriting. */
  debugId?: string;
  /**
   * File type for the manifest.
   * `"minified_source"` for JS files, `"source_map"` for .map files.
   */
  type: "minified_source" | "source_map";
  /**
   * The URL this file will be served at (with `~` prefix convention).
   * Example: `"~/$bunfs/root/bin.js"`
   */
  url: string;
  /**
   * Optional sourcemap reference for the `Sourcemap` header (minified_source entries).
   * Relative URL from the JS file to its map, e.g., `"bin.js.map"` or `"maps/app.js.map"`.
   */
  sourcemapFilename?: string;
};

/** Options for {@link uploadSourcemaps}. */
export type UploadOptions = {
  /** Organization slug. */
  org: string;
  /** Project slug. */
  project: string;
  /** Release version (optional — debug IDs can work without releases). */
  release?: string;
  /** Distribution identifier (optional — disambiguates builds within a release). */
  dist?: string;
  /** Files to upload (must already have debug IDs injected). */
  files: ArtifactFile[];
  /**
   * Block until the server finishes processing the uploaded bundle (state
   * `"ok"`), not just accepting it (`"created"`). Defaults to `false`, which
   * returns as soon as the chunks are assembled.
   */
  wait?: boolean;
  /** Cap on the {@link wait} poll, in milliseconds. Ignored unless `wait`. */
  maxWaitMs?: number;
};

/** Default cap on server-side processing wait (5 minutes), matching the legacy CLI. */
export const DEFAULT_UPLOAD_MAX_WAIT_MS = 300_000;

/**
 * Translate `--wait`/`--wait-for` flags into {@link UploadOptions} wait config.
 *
 * `--wait` blocks until fully processed; `--wait-for <secs>` does the same but
 * caps the poll. Either flag enables waiting.
 */
export function resolveUploadWait(flags: {
  wait?: boolean;
  "wait-for"?: number;
}): { wait: boolean; maxWaitMs: number } {
  const waitFor = flags["wait-for"];
  if (waitFor !== undefined && (!Number.isFinite(waitFor) || waitFor <= 0)) {
    throw new ValidationError(
      "--wait-for must be a positive number of seconds.",
      "wait-for"
    );
  }
  return {
    wait: flags.wait === true || waitFor !== undefined,
    maxWaitMs:
      waitFor !== undefined ? waitFor * 1000 : DEFAULT_UPLOAD_MAX_WAIT_MS,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Convert a `~`-prefixed URL to the bundle path used inside the ZIP.
 *
 * `"~/foo/bar.js"` → `"_/_/foo/bar.js"`, other URLs get `"_/"` prefix.
 */
function urlToBundlePath(url: string): string {
  return url.startsWith("~/") ? `_/_/${url.slice(2)}` : `_/${url}`;
}

// ── API Functions ───────────────────────────────────────────────────

/**
 * Build an artifact bundle ZIP at the given path.
 *
 * Streams entries to disk via {@link ZipWriter} — only one file's
 * compressed data is held in memory at a time.
 *
 * @param outputPath - Where to write the ZIP file
 * @param files - Source files and sourcemaps to include
 * @param options.org / project / release - Bundle metadata
 * @param options.compression - ZIP entry compression. Use `"stored"`
 *   when the wire layer will compress the chunks (zstd or gzip);
 *   compressing twice wastes CPU and barely helps wire size.
 *   Defaults to `"deflate"` so callers without a wire codec still
 *   ship reasonably-sized payloads.
 */
export async function buildArtifactBundle(
  outputPath: string,
  files: ArtifactFile[],
  options: {
    org: string;
    project: string;
    release?: string;
    dist?: string;
    compression?: ZipCompression;
  }
): Promise<void> {
  // Build manifest.json
  const filesManifest: Record<
    string,
    {
      url: string;
      type: string;
      headers: Record<string, string>;
    }
  > = {};

  for (const file of files) {
    const bundlePath = urlToBundlePath(file.url);
    const headers: Record<string, string> = {};
    if (file.debugId) {
      headers["debug-id"] = file.debugId;
    }
    if (file.sourcemapFilename) {
      headers.Sourcemap = file.sourcemapFilename;
    }

    filesManifest[bundlePath] = {
      url: file.url,
      type: file.type,
      headers,
    };
  }

  const manifest = JSON.stringify({
    org: options.org,
    project: options.project,
    ...(options.release ? { release: options.release } : {}),
    ...(options.dist ? { dist: options.dist } : {}),
    files: filesManifest,
  });

  // Stream ZIP entries to disk
  const zip = await ZipWriter.create(outputPath, {
    compression: options.compression,
  });
  try {
    await zip.addEntry("manifest.json", Buffer.from(manifest, "utf-8"));

    for (const file of files) {
      const bundlePath = urlToBundlePath(file.url);
      // Prefer in-memory content (inline sourcemaps); otherwise read from disk.
      const content = file.content ?? (await readFile(file.path));
      await zip.addEntry(bundlePath, content);
    }

    await zip.finalize();
  } catch (error) {
    // Close handle without finalizing on entry write failure
    await zip.close();
    throw error;
  }
}

/**
 * Upload sourcemaps to Sentry using the chunk-upload + assemble protocol.
 *
 * This is the main entry point that orchestrates the full upload flow:
 * build artifact bundle → chunk → upload missing → assemble.
 *
 * @param options - Upload configuration (org, project, release, files)
 * @throws {ApiError} If the upload or assembly fails
 */
export async function uploadSourcemaps(options: UploadOptions): Promise<void> {
  const { org, project, release, dist, files, wait, maxWaitMs } = options;

  // Step 1: Get chunk upload configuration
  const serverOptions = await getChunkUploadOptions(org);

  // Pick the wire codec up-front so the ZIP can skip its own
  // compression pass when the wire layer will handle it. Re-compressing
  // an already-DEFLATE'd ZIP with zstd/gzip burns CPU for ~0% wire
  // savings; STORED + zstd saves both CPU and a few percent wire bytes.
  // Without a wire codec (kill-switch / unsupported codecs) we keep
  // DEFLATE so the ZIP itself stays small.
  const encoding = pickUploadEncoding(serverOptions.compression);
  const zipCompression: ZipCompression = encoding ? "stored" : "deflate";

  // Step 2: Build artifact bundle ZIP to a temp file, then upload
  const tmpZipPath = join(tmpdir(), `sentry-artifact-bundle-${Date.now()}.zip`);
  try {
    await buildArtifactBundle(tmpZipPath, files, {
      org,
      project,
      release,
      dist,
      compression: zipCompression,
    });
    await uploadArtifactBundle({
      tmpZipPath,
      org,
      project,
      release,
      dist,
      serverOptions,
      encoding,
      wait: wait ?? false,
      maxWaitMs: maxWaitMs ?? DEFAULT_UPLOAD_MAX_WAIT_MS,
    });
  } finally {
    // Always clean up the temp file
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    await unlink(tmpZipPath).catch(() => {
      // Best-effort cleanup — OS temp directory will eventually purge it
    });
  }
}

/**
 * Upload an already-built artifact bundle ZIP to Sentry.
 *
 * Handles steps 3–6 of the upload protocol: chunk + hash → assemble →
 * upload missing → poll. Separated from {@link uploadSourcemaps} to keep
 * the try/finally cleanup boundary clean.
 */
async function uploadArtifactBundle(opts: {
  tmpZipPath: string;
  org: string;
  project: string;
  release: string | undefined;
  dist: string | undefined;
  serverOptions: ChunkServerOptions;
  encoding: UploadEncoding | undefined;
  wait: boolean;
  maxWaitMs: number;
}): Promise<void> {
  const {
    tmpZipPath,
    org,
    project,
    release,
    dist,
    serverOptions,
    encoding,
    wait,
    maxWaitMs,
  } = opts;
  // Step 3: Split into chunks, hash each chunk + compute overall checksum
  const { chunks, overallChecksum } = await hashChunks(
    tmpZipPath,
    serverOptions.chunkSize
  );

  const regionUrl = await resolveOrgRegion(org);

  // Step 4: Request assembly — server tells us which chunks it needs
  const assembleBody = {
    checksum: overallChecksum,
    chunks: chunks.map((c: ChunkInfo) => c.sha1),
    projects: [project],
    ...(release ? { version: release } : {}),
    ...(dist ? { dist } : {}),
  };

  const assembleEndpoint = `organizations/${org}/artifactbundle/assemble/`;
  const { data: firstAssemble } = await apiRequestToRegion<AssembleResponse>(
    regionUrl,
    assembleEndpoint,
    {
      method: "POST",
      body: assembleBody,
      schema: AssembleResponseSchema,
    }
  );

  // Fail fast on server-side assembly error
  if (firstAssemble.state === "error") {
    throw new ApiError(
      "Artifact bundle assembly failed",
      500,
      firstAssemble.detail ?? "Unknown error",
      assembleEndpoint
    );
  }

  // Fully assembled — nothing more to do regardless of wait.
  if (firstAssemble.state === "ok") {
    return;
  }

  // Accepted but not yet processed. Without --wait we're done; with --wait we
  // fall through to poll for full processing.
  if (firstAssemble.state === "created" && !wait) {
    return;
  }

  // Step 5: Upload missing chunks in parallel (a no-op when none are missing).
  await uploadMissingChunks({
    chunks,
    missingChecksums: new Set(firstAssemble.missingChunks ?? []),
    tmpZipPath,
    serverOptions,
    encoding,
    regionUrl,
  });

  // Step 6: Poll assemble endpoint. With --wait, block until fully processed
  // ("ok"); otherwise return as soon as the chunks are accepted ("created").
  await pollAssembly({
    regionUrl,
    endpoint: assembleEndpoint,
    body: assembleBody,
    entityName: "Artifact bundle",
    waitForOk: wait,
    deadlineMs: maxWaitMs,
  });
}
