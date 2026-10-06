/**
 * Preprod artifacts (mobile build) API.
 *
 * Backs `sentry build download`: resolves a preprod build's install/download
 * URL via the preprod-artifacts `install-details` endpoint and streams the
 * binary (APK/IPA) to disk.
 *
 * The install URL is Sentry-hosted (same origin as the org's region). iOS
 * install URLs point at a `response_format=plist` manifest; rewrite it to
 * `response_format=ipa` to fetch the actual binary. The auth token is attached
 * to the download only when the URL matches the region origin — never a
 * third-party/signed storage URL — to avoid leaking the token.
 */

import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  array,
  boolean,
  type InferOutput,
  nullable,
  nullish,
  number,
  object,
  optional,
  string,
  tuple,
} from "valibot";
import { formatAuthHeader } from "../auth-header.js";
import { customFetch } from "../custom-ca.js";
import { getAuthToken } from "../db/auth.js";
import { ApiError, TimeoutError, ValidationError } from "../errors.js";
import { logger } from "../logger.js";
import { resolveOrgRegion } from "../region.js";
import {
  ASSEMBLE_MAX_WAIT_MS,
  ASSEMBLE_POLL_INTERVAL_MS,
  AssembleResponseSchema,
  type ChunkServerOptions,
  getChunkUploadOptions,
  hashChunks,
  pickUploadEncoding,
  uploadMissingChunks,
} from "./chunk-upload.js";
import {
  apiRequestToRegion,
  apiRequestToRegionNoContent,
} from "./infrastructure.js";

const log = logger.withTag("api.preprod-artifacts");

/** Downloadable mobile build formats. */
export type BuildFormat = "ipa" | "apk";

/**
 * Response from `organizations/{org}/preprodartifacts/{id}/install-details/`.
 */
export const BuildInstallDetailsSchema = object({
  /** Whether the build has a downloadable/installable artifact. */
  isInstallable: boolean(),
  /** Absolute URL to download the artifact, or `null` when unavailable. */
  installUrl: nullable(string()),
});

/** Install/download details for a preprod build artifact. */
export type BuildInstallDetails = InferOutput<typeof BuildInstallDetailsSchema>;

/**
 * Fetch install/download details for a preprod build artifact.
 *
 * @param org - Organization slug.
 * @param buildId - Preprod artifact (build) ID.
 * @returns Whether the build is installable and its (absolute) download URL.
 * @throws {ApiError} On a non-2xx response.
 */
export async function getBuildInstallDetails(
  org: string,
  buildId: string
): Promise<BuildInstallDetails> {
  const regionUrl = await resolveOrgRegion(org);
  const endpoint = `organizations/${org}/preprodartifacts/${encodeURIComponent(
    buildId
  )}/install-details/`;
  const { data } = await apiRequestToRegion(regionUrl, endpoint, {
    schema: BuildInstallDetailsSchema,
  });
  return data;
}

/**
 * Rewrite an iOS install URL that points at a plist manifest so it fetches the
 * IPA binary directly. Non-plist URLs are returned unchanged.
 *
 * @param installUrl - The install URL from {@link getBuildInstallDetails}.
 */
export function toBinaryDownloadUrl(installUrl: string): string {
  return installUrl.replace("response_format=plist", "response_format=ipa");
}

/**
 * Infer the artifact file extension from the download URL's `response_format`.
 *
 * @param url - The (binary) download URL.
 * @throws {ValidationError} When the URL carries no recognized `response_format`.
 */
export function buildFormatFromUrl(url: string): BuildFormat {
  if (url.includes("response_format=ipa")) {
    return "ipa";
  }
  if (url.includes("response_format=apk")) {
    return "apk";
  }
  throw new ValidationError(
    "Unsupported build format in download URL",
    "installUrl"
  );
}

/**
 * Compare a URL's origin against the region base URL.
 *
 * @returns `true` only when both parse and share an origin; `false` otherwise
 *   (including parse failures, in which case the auth token is withheld).
 */
function isRegionOrigin(url: string, regionUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(regionUrl).origin;
  } catch (err) {
    log.debug(
      "Could not compare download URL origin; withholding auth token",
      err
    );
    return false;
  }
}

/**
 * Stream a build artifact to a local file.
 *
 * The auth token is attached only when `url` shares the region origin, so it is
 * never sent to a third-party/signed storage URL.
 *
 * @param regionUrl - The org's region base URL (origin gate for the token).
 * @param url - The absolute (binary) download URL.
 * @param destPath - Local path to write the artifact to.
 * @throws {ApiError} On a non-2xx response or missing body.
 */
export async function downloadBuildArtifact(
  regionUrl: string,
  url: string,
  destPath: string
): Promise<void> {
  const headers: Record<string, string> = {};
  if (isRegionOrigin(url, regionUrl)) {
    const token = getAuthToken();
    if (token) {
      headers.Authorization = formatAuthHeader(token);
    }
  }

  const response = await customFetch(url, { headers });
  if (!(response.ok && response.body)) {
    throw new ApiError(
      "Failed to download build artifact",
      response.status,
      response.statusText || "Download failed",
      url
    );
  }

  // Stream to disk so large (hundreds-of-MB) artifacts never buffer in memory.
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(destPath)
  );
}

/** Optional metadata sent with a build assemble request. */
export type BuildUploadMetadata = {
  /** Build configuration name (e.g. `Release`). */
  buildConfiguration?: string;
  /** Release notes for the build. */
  releaseNotes?: string;
  /** Install group(s) this build belongs to. */
  installGroups?: string[];
  /**
   * Pre-flattened VCS fields (snake_case, e.g. `head_sha`, `provider`) merged
   * into the assemble body. Built via `vcsInfoToBody` in the build/vcs module.
   */
  vcs?: Record<string, unknown>;
};

/** Options for {@link uploadBuild}. */
export type BuildUploadOptions = {
  /** Organization slug. */
  org: string;
  /** Project slug. */
  project: string;
  /** Path to the normalized wrapper-ZIP on disk to upload. */
  contentPath: string;
  /** Optional build metadata folded into the assemble body. */
  metadata: BuildUploadMetadata;
  /** Pre-fetched chunk upload options (fetched if omitted). */
  serverOptions?: ChunkServerOptions;
};

/**
 * Build assemble response — the shared assemble shape plus `artifactUrl`, which
 * is populated once the build has been fully assembled.
 */
const BuildAssembleResponseSchema = object({
  ...AssembleResponseSchema.entries,
  artifactUrl: nullish(string()),
});

/** Construct the single-object assemble request body for a build. */
function buildAssembleBody(
  checksum: string,
  chunkShas: string[],
  metadata: BuildUploadMetadata
): Record<string, unknown> {
  const body: Record<string, unknown> = { checksum, chunks: chunkShas };
  if (metadata.buildConfiguration) {
    body.build_configuration = metadata.buildConfiguration;
  }
  if (metadata.releaseNotes) {
    body.release_notes = metadata.releaseNotes;
  }
  if (metadata.installGroups?.length) {
    body.install_groups = metadata.installGroups;
  }
  // VCS fields are flattened into the assemble body (server flattens `VcsInfo`).
  Object.assign(body, metadata.vcs ?? {});
  return body;
}

/**
 * Upload a normalized build via the chunk-upload + preprod-artifacts assemble
 * protocol, polling until the server finishes assembling.
 *
 * Unlike DIF uploads there is no no-wait mode: assembly always runs to
 * completion (or {@link ASSEMBLE_MAX_WAIT_MS}) because the artifact URL is only
 * known once the build is assembled.
 *
 * @param options - Upload configuration.
 * @returns The assembled artifact's URL.
 * @throws {ApiError} On an assembly error or timeout.
 */
export async function uploadBuild(
  options: BuildUploadOptions
): Promise<string> {
  const { org, project, contentPath, metadata } = options;
  const serverOptions =
    options.serverOptions ?? (await getChunkUploadOptions(org));
  const encoding = pickUploadEncoding(serverOptions.compression);
  const { chunks, overallChecksum } = await hashChunks(
    contentPath,
    serverOptions.chunkSize
  );
  const regionUrl = await resolveOrgRegion(org);
  const endpoint = `projects/${org}/${project}/files/preprodartifacts/assemble/`;

  const body = buildAssembleBody(
    overallChecksum,
    chunks.map((chunk) => chunk.sha1),
    metadata
  );

  const deadline = Date.now() + ASSEMBLE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const { data } = await apiRequestToRegion(regionUrl, endpoint, {
      method: "POST",
      body,
      schema: BuildAssembleResponseSchema,
    });

    if (data.state === "error") {
      throw new ApiError(
        "Build assembly failed",
        500,
        data.detail ?? "Unknown error",
        endpoint
      );
    }
    if (data.artifactUrl) {
      return data.artifactUrl;
    }
    // A finished ("ok") state without an artifact URL is terminal — fail fast
    // rather than polling to the deadline (matches the legacy loop).
    if (data.state === "ok") {
      throw new ApiError(
        "Build assembled but no artifact URL was returned",
        500,
        data.detail ?? "",
        endpoint
      );
    }

    const missing = new Set(data.missingChunks ?? []);
    if (missing.size > 0) {
      await uploadMissingChunks({
        chunks,
        missingChecksums: missing,
        tmpZipPath: contentPath,
        serverOptions,
        encoding,
        regionUrl,
      });
    }

    // Always pace between assemble POSTs (matches the legacy poll loop and
    // avoids a busy loop should the server keep reporting the same chunks).
    await new Promise((r) => setTimeout(r, ASSEMBLE_POLL_INTERVAL_MS));
  }

  throw new ApiError(
    "Build assembly timed out",
    408,
    `Assembly did not complete within ${ASSEMBLE_MAX_WAIT_MS / 1000}s`,
    endpoint
  );
}

/** Strip trailing slashes without a regex (avoids ReDoS heuristics). */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end -= 1;
  }
  return url.slice(0, end);
}

/** Poll interval while waiting for a snapshot archive to build. */
export const SNAPSHOT_ARCHIVE_POLL_MS = 2000;
/** Maximum time to wait for a snapshot archive to build. */
export const SNAPSHOT_ARCHIVE_TIMEOUT_MS = 300_000;

/**
 * Raw latest-baseline response. The server returns snake_case fields (no
 * `camelCase` rename on the Rust `LatestBaseSnapshotResponse`); callers get the
 * camelCase {@link LatestBaseSnapshot} after mapping.
 */
export const LatestBaseSnapshotSchema = object({
  /** Artifact ID of the baseline snapshot. */
  head_artifact_id: string(),
  /** Number of images in the snapshot. */
  image_count: number(),
});

/** Latest baseline snapshot for an app (camelCase, for callers). */
export type LatestBaseSnapshot = {
  headArtifactId: string;
  imageCount: number;
};

/** Build the `.../snapshots/{id}/archive/` endpoint path. */
function snapshotArchiveEndpoint(org: string, snapshotId: string): string {
  return `organizations/${org}/preprodartifacts/snapshots/${encodeURIComponent(
    snapshotId
  )}/archive/`;
}

/**
 * Resolve the latest baseline snapshot for an app.
 *
 * @param org - Organization slug.
 * @param appId - App identifier (e.g. `sentry-frontend`).
 * @param opts - Optional `branch` filter and `project` (numeric ID, required
 *   with org auth tokens).
 * @returns The latest baseline snapshot, or `null` when none exists.
 * @throws {ApiError} On a non-2xx response other than 404.
 */
export async function getLatestBaseSnapshot(
  org: string,
  appId: string,
  opts: { branch?: string; project?: string } = {}
): Promise<LatestBaseSnapshot | null> {
  const regionUrl = await resolveOrgRegion(org);
  try {
    const { data } = await apiRequestToRegion(
      regionUrl,
      `organizations/${org}/preprodartifacts/snapshots/latest-base/`,
      {
        params: { app_id: appId, branch: opts.branch, project: opts.project },
        schema: nullable(LatestBaseSnapshotSchema),
      }
    );
    return data
      ? { headArtifactId: data.head_artifact_id, imageCount: data.image_count }
      : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/** Objectstore config within the snapshots upload-options response. */
const ObjectstoreUploadOptionsSchema = object({
  url: string(),
  usecase: optional(string(), "preprod"),
  scopes: array(tuple([string(), string()])),
  authToken: nullish(string()),
  expirationPolicy: string(),
});

/** Response from `.../snapshots/upload-options/`. */
const SnapshotsUploadOptionsSchema = object({
  objectstore: ObjectstoreUploadOptionsSchema,
});

/** Snapshot upload options (objectstore config), for the caller. */
export type SnapshotsUploadOptions = InferOutput<
  typeof SnapshotsUploadOptionsSchema
>;

/**
 * Fetch objectstore upload options (URL, scopes, token, expiration) for
 * uploading snapshot images.
 *
 * @throws {ApiError} On a non-2xx response.
 */
export async function fetchSnapshotsUploadOptions(
  org: string,
  project: string
): Promise<SnapshotsUploadOptions> {
  const regionUrl = await resolveOrgRegion(org);
  const { data } = await apiRequestToRegion(
    regionUrl,
    `projects/${org}/${project}/preprodartifacts/snapshots/upload-options/`,
    { params: { usecase: "auto" }, schema: SnapshotsUploadOptionsSchema }
  );
  return data;
}

/** Response from the create-snapshot endpoint. */
const CreateSnapshotResponseSchema = object({
  artifactId: string(),
  imageCount: number(),
  snapshotUrl: nullish(string()),
});

/** Result of creating a preprod snapshot. */
export type CreateSnapshotResponse = InferOutput<
  typeof CreateSnapshotResponseSchema
>;

/**
 * Create a preprod snapshot from an uploaded image manifest.
 *
 * @param manifest - The snapshot manifest (app id, per-image metadata, VCS,
 *   selective flags).
 * @throws {ApiError} On a non-2xx response.
 */
export async function createPreprodSnapshot(
  org: string,
  project: string,
  manifest: Record<string, unknown>
): Promise<CreateSnapshotResponse> {
  const regionUrl = await resolveOrgRegion(org);
  const { data } = await apiRequestToRegion(
    regionUrl,
    `projects/${org}/${project}/preprodartifacts/snapshots/`,
    {
      method: "POST",
      body: manifest,
      // A large image suite makes a large manifest; compress like the legacy CLI.
      bodyEncoding: "zstd",
      schema: CreateSnapshotResponseSchema,
    }
  );
  return data;
}

const SnapshotArchiveStatusSchema = object({ ready: boolean() });

/**
 * Check whether a snapshot's downloadable archive has been built.
 *
 * @throws {ApiError} On a non-2xx response.
 */
export async function getSnapshotArchiveReady(
  org: string,
  snapshotId: string
): Promise<boolean> {
  const regionUrl = await resolveOrgRegion(org);
  const { data } = await apiRequestToRegion(
    regionUrl,
    snapshotArchiveEndpoint(org, snapshotId),
    { schema: SnapshotArchiveStatusSchema }
  );
  return data.ready;
}

/**
 * Trigger a build of a snapshot's downloadable archive.
 *
 * @throws {ApiError} On a non-2xx response.
 */
export async function triggerSnapshotArchiveBuild(
  org: string,
  snapshotId: string
): Promise<void> {
  const regionUrl = await resolveOrgRegion(org);
  await apiRequestToRegionNoContent(
    regionUrl,
    snapshotArchiveEndpoint(org, snapshotId),
    { method: "POST" }
  );
}

/**
 * Ensure a snapshot's archive is built, triggering a build and polling if needed.
 *
 * @param onBuildStarted - Invoked once when a build is triggered (for progress
 *   messaging); the API layer does no user-facing output itself.
 * @throws {TimeoutError} When the archive is not ready within the timeout.
 * @throws {ApiError} On a non-2xx response.
 */
export async function waitForSnapshotArchive(
  org: string,
  snapshotId: string,
  onBuildStarted?: () => void
): Promise<void> {
  if (await getSnapshotArchiveReady(org, snapshotId)) {
    return;
  }
  await triggerSnapshotArchiveBuild(org, snapshotId);
  onBuildStarted?.();

  const deadline = Date.now() + SNAPSHOT_ARCHIVE_TIMEOUT_MS;
  while (!(await getSnapshotArchiveReady(org, snapshotId))) {
    if (Date.now() >= deadline) {
      throw new TimeoutError(
        `Snapshot archive was not ready after ${
          SNAPSHOT_ARCHIVE_TIMEOUT_MS / 1000
        }s. The build may still be running; try again shortly.`
      );
    }
    await new Promise((r) => setTimeout(r, SNAPSHOT_ARCHIVE_POLL_MS));
  }
}

/**
 * Open a snapshot's archive ZIP for streaming.
 *
 * Returns the raw HTTP `Response` (body unconsumed) so the caller can
 * stream-extract it without buffering the whole archive in memory. The endpoint
 * streams the ZIP directly from the region origin (no redirect), so the auth
 * token is only ever sent to the region host; should the server ever 302 to
 * third-party storage, undici strips `Authorization` cross-origin.
 *
 * @throws {ApiError} On a non-2xx response.
 */
export async function openSnapshotArchive(
  org: string,
  snapshotId: string
): Promise<Response> {
  const regionUrl = stripTrailingSlashes(await resolveOrgRegion(org));
  const url = `${regionUrl}/api/0/${snapshotArchiveEndpoint(
    org,
    snapshotId
  )}?download`;
  const headers: Record<string, string> = {};
  const token = getAuthToken();
  if (token) {
    headers.Authorization = formatAuthHeader(token);
  }
  const response = await customFetch(url, { headers });
  if (!response.ok) {
    throw new ApiError(
      "Failed to download snapshot archive",
      response.status,
      response.statusText || "Download failed",
      url
    );
  }
  return response;
}
