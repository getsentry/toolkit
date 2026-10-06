/**
 * Minimal Objectstore HTTP client for snapshot image uploads.
 *
 * Replicates the subset of the `objectstore-client` protocol (getsentry/objectstore)
 * that `snapshots upload` needs: HEAD an object to check existence (dedup) and
 * PUT its bytes. The service URL, scopes, auth token, and expiration policy all
 * come from the Sentry `snapshots/upload-options/` endpoint — this client never
 * signs tokens itself (the token is a pre-signed JWT).
 *
 * Object path layout: `{serviceUrl}/v1/objects/{usecase}/{scope}/{key}` where
 * `scope` is a `;`-joined list of ordered `key=value` pairs. Auth is carried in
 * the `x-os-auth: Bearer <token>` header (not the standard `Authorization`).
 */

import { customFetch } from "./custom-ca.js";
import { ApiError } from "./errors.js";

/** Header carrying the Objectstore bearer token. */
const AUTH_HEADER = "x-os-auth";
/** Header carrying an object's expiration policy (e.g. `ttl:30d`). */
const EXPIRATION_HEADER = "x-sn-expiration";

/** Matches one or more trailing slashes (for base-URL normalization). */
const TRAILING_SLASHES = /\/+$/;

/** Timeout for a HEAD existence check. */
const HEAD_TIMEOUT_MS = 30_000;
/** Timeout for uploading a single object. */
const PUT_TIMEOUT_MS = 120_000;

/**
 * Objectstore upload configuration, as returned (camelCase) by the Sentry
 * `snapshots/upload-options/` endpoint.
 */
export type ObjectstoreConfig = {
  /** Base service URL (may include a path prefix). */
  url: string;
  usecase: string;
  /** Ordered scope pairs (e.g. `[["org","1"],["project","2"]]`). */
  scopes: [string, string][];
  /** Pre-signed bearer token, or null/absent for unauthenticated stores. */
  authToken?: string | null;
  /** Expiration policy string applied to uploaded objects. */
  expirationPolicy: string;
};

/** Render scope pairs into the `k=v;k=v` path segment. */
function scopeSegment(scopes: [string, string][]): string {
  return scopes.map(([key, value]) => `${key}=${value}`).join(";");
}

/**
 * Build the full URL for an object key within the configured usecase + scope.
 *
 * @param config - The objectstore configuration.
 * @param key - The object key (e.g. `<orgId>/<projectId>/<sha256>`).
 */
export function buildObjectUrl(config: ObjectstoreConfig, key: string): string {
  const base = config.url.replace(TRAILING_SLASHES, "");
  return `${base}/v1/objects/${config.usecase}/${scopeSegment(
    config.scopes
  )}/${key}`;
}

/** Auth headers for an objectstore request, if a token is configured. */
function authHeaders(config: ObjectstoreConfig): Record<string, string> {
  return config.authToken
    ? { [AUTH_HEADER]: `Bearer ${config.authToken}` }
    : {};
}

/**
 * Check whether an object already exists (used to skip re-uploads).
 *
 * @returns `true` if the object exists, `false` on a 404.
 * @throws {ApiError} On any non-2xx, non-404 response.
 */
export async function objectExists(
  config: ObjectstoreConfig,
  key: string
): Promise<boolean> {
  const url = buildObjectUrl(config, key);
  const response = await customFetch(url, {
    method: "HEAD",
    headers: authHeaders(config),
    signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
  });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new ApiError(
      "Objectstore HEAD failed",
      response.status,
      response.statusText || "HEAD failed",
      url
    );
  }
  return true;
}

/**
 * Upload an object's bytes (raw — no content encoding).
 *
 * The key is derived from the original file's SHA-256, so dedup via
 * {@link objectExists} is independent of any upload compression; images are
 * already-compressed formats, so storing them raw avoids pointless CPU.
 *
 * @throws {ApiError} On a non-2xx response.
 */
export async function putObject(
  config: ObjectstoreConfig,
  key: string,
  body: Uint8Array
): Promise<void> {
  const url = buildObjectUrl(config, key);
  const response = await customFetch(url, {
    method: "PUT",
    headers: {
      ...authHeaders(config),
      [EXPIRATION_HEADER]: config.expirationPolicy,
    },
    body,
    signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ApiError(
      "Objectstore upload failed",
      response.status,
      response.statusText || "PUT failed",
      url
    );
  }
}
