/**
 * GHCR (GitHub Container Registry) Client
 *
 * Encapsulates the OCI download protocol for fetching nightly CLI binaries
 * from ghcr.io/getsentry/cli. Nightly builds are pushed as OCI artifacts
 * via ORAS with the version baked into the manifest annotation.
 *
 * Key design decisions:
 * - Anonymous access: nightly package is public; no token needed beyond the
 *   standard ghcr.io anonymous token exchange.
 * - Version discovery from manifest annotation: `annotations.version` in the
 *   OCI manifest holds the nightly version. Checking the latest version only
 *   requires a token exchange + manifest fetch (2 HTTP requests total).
 * - Redirect quirk: ghcr.io blob downloads return 307 to Azure Blob Storage.
 *   Using `fetch` with `redirect: "follow"` would forward the Authorization
 *   header to Azure, which returns 404. Must follow the redirect manually
 *   without the auth header.
 */

import { valid as semverValid } from "semver";
import {
  PRIMARY_UPGRADE_SOURCE,
  parseUpgradeJson,
  type UpgradeSource,
} from "./binary.js";
import { getUserAgent } from "./constants.js";
import { customFetch } from "./custom-ca.js";
import { UpgradeError, UpgradeTransportError } from "./errors.js";

/** Default timeout for GHCR HTTP requests (10 seconds) */
const GHCR_REQUEST_TIMEOUT = 10_000;

/** Maximum number of retry attempts for transient failures */
const GHCR_MAX_RETRIES = 1;

/** Nightly versions use a numeric build timestamp as the prerelease value. */
const NIGHTLY_VERSION_REGEX = /^\d+\.\d+\.\d+-dev\.\d+$/;

/** Timeout for large blob downloads (30 seconds) */
const GHCR_BLOB_TIMEOUT = 30_000;

/**
 * Check if an error is a transient network/timeout failure worth retrying.
 *
 * Matches timeout/abort errors from `AbortSignal.timeout()`, connection
 * resets, and generic network failures. Does NOT match HTTP-level errors
 * (those are handled by the caller after receiving a Response).
 */
function isRetryableError(error: Error): boolean {
  // AbortSignal.timeout() throws a TimeoutError DOMException — check by name
  // rather than relying on error message content (which varies across runtimes)
  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return true;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("fetch failed")
  );
}

/**
 * Build a combined abort signal from the per-request timeout and an
 * optional external signal (e.g., process-exit abort controller).
 */
function buildSignal(
  timeout: number,
  externalSignal?: AbortSignal
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeout);
  return externalSignal
    ? AbortSignal.any([timeoutSignal, externalSignal])
    : timeoutSignal;
}

function rethrowExternalAbort(
  _error: unknown,
  externalSignal?: AbortSignal
): void {
  if (externalSignal?.aborted) {
    throw externalSignal?.reason;
  }
}

type RetryOptions = {
  timeout?: number;
  signal?: AbortSignal;
};

/**
 * Fetch with timeout and retry for GHCR requests.
 *
 * GHCR exhibits cold-start latency spikes (126ms → 30s for identical
 * requests). A short timeout + retry keeps the worst case at ~20s instead
 * of 30s, and helps when the first request hits a cold instance.
 *
 * @param url - Request URL
 * @param init - Fetch init options (signal will be added/overridden)
 * @param context - Human-readable context for error messages
 * @param options - Retry options (timeout override, external abort signal)
 * @returns Response from a successful fetch
 * @throws {UpgradeError} On all attempts exhausted
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  context: string,
  options?: RetryOptions
): Promise<Response> {
  const timeout = options?.timeout ?? GHCR_REQUEST_TIMEOUT;
  const externalSignal = options?.signal;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= GHCR_MAX_RETRIES; attempt++) {
    try {
      const response = await customFetch(url, {
        ...init,
        signal: buildSignal(timeout, externalSignal),
      });
      return response;
    } catch (error) {
      // Propagate external abort immediately — don't retry caller cancellation
      if (externalSignal?.aborted) {
        throw externalSignal.reason;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      // Only retry on timeout or network errors — not HTTP errors
      if (attempt >= GHCR_MAX_RETRIES || !isRetryableError(lastError)) {
        break;
      }
    }
  }

  throw new UpgradeTransportError(
    `${context}: ${lastError?.message ?? "unknown error"}`
  );
}

/** Default GHCR repository for CLI distribution. */
export const GHCR_REPO = PRIMARY_UPGRADE_SOURCE.ghcrRepo;

/** OCI tag for nightly builds */
export const GHCR_TAG = "nightly";

/** Base URL for GHCR registry API */
const GHCR_REGISTRY = "https://ghcr.io";

/** OCI manifest media type */
const OCI_MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";

/** An OCI manifest request received a non-successful HTTP response. */
export class GhcrManifestHttpError extends UpgradeError {
  /** HTTP status returned by GHCR. */
  readonly status: number;

  constructor(tag: string, status: number) {
    super(
      "network_error",
      `Failed to fetch manifest for tag "${tag}": HTTP ${status}`
    );
    this.name = "GhcrManifestHttpError";
    this.status = status;
  }
}

/**
 * A single layer entry from an OCI manifest.
 *
 * Each binary in the nightly push is stored as a separate layer.
 * The `annotations` map includes `org.opencontainers.image.title` (filename)
 * and `org.opencontainers.image.created` (push time).
 */
export type OciLayer = {
  /** Content-addressable digest for the blob (e.g., "sha256:abc123...") */
  digest: string;
  /** MIME type of the layer content */
  mediaType: string;
  /** Size in bytes */
  size: number;
  /** Per-layer OCI annotations */
  annotations?: Record<string, string>;
};

/**
 * OCI image manifest returned by the registry.
 *
 * The `annotations` map at the manifest level holds metadata about the
 * nightly push, including the `version` string baked in during `oras push`.
 */
export type OciManifest = {
  /** OCI manifest schema version (always 2) */
  schemaVersion: number;
  /** Manifest media type */
  mediaType?: string;
  /** Config layer (empty for ORAS artifacts) */
  config?: OciLayer;
  /** Content layers — one per binary/file pushed */
  layers: OciLayer[];
  /** Manifest-level annotations, including `version` */
  annotations?: Record<string, string>;
};

const SHA256_DIGEST_REGEX = /^sha256:[0-9a-f]{64}$/;

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isOciLayer(value: unknown): value is OciLayer {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const layer = value as Partial<OciLayer>;
  return (
    typeof layer.digest === "string" &&
    SHA256_DIGEST_REGEX.test(layer.digest) &&
    typeof layer.mediaType === "string" &&
    Number.isSafeInteger(layer.size) &&
    (layer.size ?? -1) >= 0 &&
    (layer.annotations === undefined || isStringRecord(layer.annotations))
  );
}

function isOciManifest(value: unknown): value is OciManifest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const manifest = value as Partial<OciManifest>;
  return (
    manifest.schemaVersion === 2 &&
    Array.isArray(manifest.layers) &&
    manifest.layers.every(isOciLayer) &&
    (manifest.mediaType === undefined ||
      typeof manifest.mediaType === "string") &&
    (manifest.config === undefined || isOciLayer(manifest.config)) &&
    (manifest.annotations === undefined || isStringRecord(manifest.annotations))
  );
}

/**
 * Fetch a short-lived anonymous bearer token for read-only access to the
 * public `ghcr.io/getsentry/cli` package.
 *
 * The token exchange endpoint returns a JSON object with a `token` field.
 * No credentials are required for public packages.
 *
 * @returns Bearer token string
 * @throws {UpgradeError} On network failure or malformed response
 */
export async function getAnonymousToken(
  sourceOrSignal: UpgradeSource | AbortSignal = PRIMARY_UPGRADE_SOURCE,
  signal?: AbortSignal
): Promise<string> {
  const source =
    "ghcrRepo" in sourceOrSignal ? sourceOrSignal : PRIMARY_UPGRADE_SOURCE;
  const externalSignal = "ghcrRepo" in sourceOrSignal ? signal : sourceOrSignal;
  const url = `${GHCR_REGISTRY}/token?scope=repository:${source.ghcrRepo}:pull`;
  const response = await fetchWithRetry(
    url,
    { headers: { "User-Agent": getUserAgent() } },
    "Failed to connect to GHCR",
    { signal: externalSignal }
  );

  if (!response.ok) {
    throw new UpgradeError(
      "network_error",
      `GHCR token exchange failed: HTTP ${response.status}`
    );
  }

  const data = await parseUpgradeJson(
    response,
    externalSignal,
    "GHCR token exchange returned invalid metadata"
  );
  if (
    typeof data !== "object" ||
    data === null ||
    !("token" in data) ||
    typeof data.token !== "string" ||
    data.token.length === 0 ||
    data.token.trim() !== data.token
  ) {
    throw new UpgradeError(
      "network_error",
      "GHCR token exchange returned no token"
    );
  }

  return data.token;
}

/**
 * Fetch the OCI manifest for an arbitrary tag from GHCR.
 *
 * @param token - Anonymous bearer token from {@link getAnonymousToken}
 * @param tag - OCI tag to fetch (e.g., "nightly", "nightly-0.14.0-dev.123", "patch-0.14.0-dev.123")
 * @returns Parsed OCI manifest
 * @throws {UpgradeError} On network failure or non-200 response
 */
export async function fetchManifest(
  token: string,
  tag: string,
  signal?: AbortSignal,
  source: UpgradeSource = PRIMARY_UPGRADE_SOURCE
): Promise<OciManifest> {
  const url = `${GHCR_REGISTRY}/v2/${source.ghcrRepo}/manifests/${tag}`;
  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: OCI_MANIFEST_TYPE,
        "User-Agent": getUserAgent(),
      },
    },
    `Failed to fetch manifest for tag "${tag}"`,
    { signal }
  );

  if (!response.ok) {
    throw new GhcrManifestHttpError(tag, response.status);
  }

  const data = await parseUpgradeJson(
    response,
    signal,
    `Manifest for tag "${tag}" returned invalid metadata`
  );
  if (!isOciManifest(data)) {
    throw new UpgradeError(
      "network_error",
      `Manifest for tag "${tag}" returned invalid metadata`
    );
  }
  return data;
}

/**
 * Fetch the OCI manifest for the `:nightly` tag.
 *
 * Convenience wrapper around {@link fetchManifest} for the rolling nightly tag.
 *
 * @param token - Anonymous bearer token from {@link getAnonymousToken}
 * @returns Parsed OCI manifest
 * @throws {UpgradeError} On network failure or non-200 response
 */
export async function fetchNightlyManifest(
  token: string,
  signal?: AbortSignal,
  source: UpgradeSource = PRIMARY_UPGRADE_SOURCE
): Promise<OciManifest> {
  return await fetchManifest(token, GHCR_TAG, signal, source);
}

/**
 * Extract the nightly version string from a manifest's annotations.
 *
 * The version is set via `--annotation "version=<ver>"` during `oras push`.
 *
 * @param manifest - OCI manifest from {@link fetchNightlyManifest}
 * @returns Version string (e.g., "0.13.0-dev.1740000000")
 * @throws {UpgradeError} When the version annotation is missing
 */
export function getNightlyVersion(manifest: OciManifest): string {
  const version = manifest.annotations?.version;
  if (!version) {
    throw new UpgradeError(
      "network_error",
      "Nightly manifest has no version annotation"
    );
  }
  if (semverValid(version) === null || !NIGHTLY_VERSION_REGEX.test(version)) {
    throw new UpgradeError(
      "network_error",
      "Nightly manifest has invalid version annotation"
    );
  }
  return version;
}

/**
 * Find the layer matching a given filename in an OCI manifest.
 *
 * ORAS sets `org.opencontainers.image.title` to the filename for each pushed
 * file. This function searches layers for the matching title annotation.
 *
 * @param manifest - OCI manifest containing layers
 * @param filename - Filename to find (e.g., "sentry-linux-x64.gz")
 * @returns Matching layer
 * @throws {UpgradeError} When no layer matches the filename
 */
export function findLayerByFilename(
  manifest: OciManifest,
  filename: string
): OciLayer {
  const layer = manifest.layers.find(
    (l) => l.annotations?.["org.opencontainers.image.title"] === filename
  );
  if (!layer) {
    throw new UpgradeError(
      "version_not_found",
      `No nightly build found for ${filename}`
    );
  }
  return layer;
}

/**
 * Download a nightly binary blob from GHCR and write it to disk.
 *
 * The blob endpoint returns a 307 redirect to a signed Azure Blob Storage URL.
 * `fetch` with `redirect: "follow"` would forward the Authorization header
 * to Azure, which returns 404. We must:
 * 1. Fetch the blob URL without following redirects to get the redirect URL.
 * 2. Follow the redirect URL without the Authorization header.
 *
 * @param token - Anonymous bearer token from {@link getAnonymousToken}
 * @param digest - Layer digest to download (e.g., "sha256:abc123...")
 * @returns Raw response body (gzip-compressed binary)
 * @throws {UpgradeError} On network failure or bad response
 */
export async function downloadNightlyBlob(
  token: string,
  digest: string,
  signal?: AbortSignal,
  source: UpgradeSource = PRIMARY_UPGRADE_SOURCE
): Promise<Response> {
  const blobUrl = `${GHCR_REGISTRY}/v2/${source.ghcrRepo}/blobs/${digest}`;

  // Step 1: GET blob URL with auth, but do NOT follow redirects.
  // ghcr.io returns 307 → Azure Blob Storage signed URL.
  let blobResponse: Response;
  try {
    blobResponse = await customFetch(blobUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": getUserAgent(),
      },
      redirect: "manual",
      signal: buildSignal(GHCR_BLOB_TIMEOUT, signal),
    });
  } catch (error) {
    rethrowExternalAbort(error, signal);
    const msg = error instanceof Error ? error.message : String(error);
    throw new UpgradeError(
      "network_error",
      `Failed to connect to GHCR: ${msg}`
    );
  }

  // ghcr.io may serve the blob directly (200) or redirect (301/302/307/308)
  if (blobResponse.status === 200) {
    return blobResponse;
  }

  if (
    blobResponse.status === 301 ||
    blobResponse.status === 302 ||
    blobResponse.status === 307 ||
    blobResponse.status === 308
  ) {
    const redirectUrl = blobResponse.headers.get("location");
    if (!redirectUrl) {
      throw new UpgradeError(
        "network_error",
        `GHCR blob redirect (${blobResponse.status}) had no Location header`
      );
    }

    // Step 2: Follow the redirect WITHOUT the Authorization header.
    // Azure rejects requests that include a Bearer token alongside its own
    // signed query-string credentials (returns 404).
    // No AbortSignal.timeout here: this fetch covers both connection AND
    // body streaming. For full nightly binaries (~30 MB), a 30s timeout
    // would require sustained ~8 Mbps throughput and fail on slow connections.
    // The GHCR step 1 timeout above guards against GHCR-side latency;
    // Azure Blob Storage has reliable latency characteristics.
    let redirectResponse: Response;
    try {
      redirectResponse = await customFetch(redirectUrl, {
        headers: { "User-Agent": getUserAgent() },
        signal,
      });
    } catch (error) {
      rethrowExternalAbort(error, signal);
      const msg = error instanceof Error ? error.message : String(error);
      throw new UpgradeError(
        "network_error",
        `Failed to download from blob storage: ${msg}`
      );
    }

    if (!redirectResponse.ok) {
      throw new UpgradeError(
        "network_error",
        `Blob storage download failed: HTTP ${redirectResponse.status}`
      );
    }

    return redirectResponse;
  }

  throw new UpgradeError(
    "network_error",
    `Unexpected GHCR blob response: HTTP ${blobResponse.status}`
  );
}

/** Page size for tag listing pagination */
const TAGS_PAGE_SIZE = 100;

/**
 * Fetch a single page of tags from the GHCR registry.
 *
 * @param token - Bearer token for authentication
 * @param lastTag - Last tag from previous page (for pagination), or undefined for the first page
 * @returns Array of tag strings for this page
 * @throws {UpgradeError} On network failure
 */
async function fetchTagPage(
  token: string,
  lastTag?: string,
  signal?: AbortSignal,
  source: UpgradeSource = PRIMARY_UPGRADE_SOURCE
): Promise<string[]> {
  let url = `${GHCR_REGISTRY}/v2/${source.ghcrRepo}/tags/list?n=${TAGS_PAGE_SIZE}`;
  if (lastTag) {
    url += `&last=${encodeURIComponent(lastTag)}`;
  }

  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": getUserAgent(),
      },
    },
    "Failed to list GHCR tags",
    { signal }
  );

  if (!response.ok) {
    throw new UpgradeError(
      "network_error",
      `Failed to list GHCR tags: HTTP ${response.status}`
    );
  }

  const data = await parseUpgradeJson(
    response,
    signal,
    "GHCR tag list returned invalid metadata"
  );
  if (typeof data !== "object" || data === null) {
    throw new UpgradeError(
      "network_error",
      "GHCR tag list returned invalid metadata"
    );
  }
  if (!("tags" in data)) {
    return [];
  }
  if (
    !(
      Array.isArray(data.tags) &&
      data.tags.every((tag) => typeof tag === "string")
    )
  ) {
    throw new UpgradeError(
      "network_error",
      "GHCR tag list returned invalid metadata"
    );
  }
  return data.tags;
}

/**
 * List tags in the GHCR repository, optionally filtered by prefix.
 *
 * Uses the OCI Distribution Spec `/v2/<name>/tags/list` endpoint with
 * pagination. Returns tags sorted lexicographically by the registry.
 *
 * @param token - Anonymous bearer token from {@link getAnonymousToken}
 * @param prefix - Optional prefix filter (e.g., "nightly-" to list versioned nightlies)
 * @returns Array of matching tag strings
 * @throws {UpgradeError} On network failure
 */
export async function listTags(
  token: string,
  prefix?: string,
  signal?: AbortSignal,
  source: UpgradeSource = PRIMARY_UPGRADE_SOURCE
): Promise<string[]> {
  const allTags: string[] = [];
  const visitedCursors = new Set<string>();
  let lastTag: string | undefined;

  for (;;) {
    const tags = await fetchTagPage(token, lastTag, signal, source);
    if (tags.length === 0) {
      break;
    }

    for (const tag of tags) {
      if (!prefix || tag.startsWith(prefix)) {
        allTags.push(tag);
      }
    }

    if (tags.length < TAGS_PAGE_SIZE) {
      break;
    }

    const nextTag = tags.at(-1);
    if (!nextTag || visitedCursors.has(nextTag)) {
      throw new UpgradeError(
        "network_error",
        "GHCR tag pagination returned a repeated cursor"
      );
    }
    visitedCursors.add(nextTag);
    lastTag = nextTag;
  }

  return allTags;
}

/**
 * Download an OCI layer blob as an ArrayBuffer.
 *
 * Uses the same redirect-without-auth pattern as {@link downloadNightlyBlob},
 * but returns the fully-buffered ArrayBuffer instead of a streaming Response.
 * Suitable for small payloads like patch files (50-500 KB).
 *
 * @param token - Anonymous bearer token from {@link getAnonymousToken}
 * @param digest - Layer digest to download (e.g., "sha256:abc123...")
 * @returns Raw blob contents as ArrayBuffer
 * @throws {UpgradeError} On network failure or bad response
 */
export async function downloadLayerBlob(
  token: string,
  digest: string,
  signal?: AbortSignal,
  source: UpgradeSource = PRIMARY_UPGRADE_SOURCE
): Promise<ArrayBuffer> {
  const response = await downloadNightlyBlob(token, digest, signal, source);
  return response.arrayBuffer();
}
