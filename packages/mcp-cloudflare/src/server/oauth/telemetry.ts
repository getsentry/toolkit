const AUTH_PARAM_SEPARATOR = /,\s*(?=[A-Za-z_][A-Za-z0-9_-]*\s*=)/;
const AUTH_CHALLENGE = /^(\S+)(?:\s+(.+))?$/;

export type OAuthBearerShape =
  | "missing"
  | "non_scheme"
  | "empty_scheme"
  | "wrapper"
  | "malformed";

// Scrubber-safe buckets: avoid default Sentry sensitive substrings in emitted
// values (token, bearer, auth/oauth, credentials) so they are not replaced
// with "[Filtered]".
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_access"
  | "invalid_target"
  | "unsupported_grant_type"
  | "invalid_client_metadata"
  | "not_implemented"
  | "other";

export type OAuthErrorTelemetry = {
  oauthError?: OAuthErrorCode;
  oauthErrorReason?: string;
  oauthBearerShape?: OAuthBearerShape;
};

/**
 * Scrubber-safe attribute keys for OAuth diagnostics.
 *
 * Default Sentry data scrubbing treats keys/values containing sensitive
 * substrings (`auth` including inside `oauth`, `token`, `bearer`,
 * `credentials`, …) as sensitive, replacing values with `[Filtered]`.
 * Keep metric *names* under `app.oauth.*` for continuity; put filterable
 * dimensions under these keys and use scrubber-safe bucket values.
 */
export const ACCESS_METHOD_ATTRIBUTE = "app.access.method" as const;
export const OAUTH_ERROR_ATTRIBUTE = "app.access.error.code" as const;
export const OAUTH_ERROR_REASON_ATTRIBUTE = "app.access.error.reason" as const;
export const OAUTH_REQUEST_HEADER_SHAPE_ATTRIBUTE =
  "app.access.request.header_shape" as const;
export const OAUTH_REFRESH_OUTCOME_ATTRIBUTE =
  "app.access.refresh.outcome" as const;
export const OAUTH_GRANT_SHAPE_ATTRIBUTE = "app.access.grant.shape" as const;
export const OAUTH_GRANT_ID_HASH_ATTRIBUTE =
  "app.access.grant.id_hash" as const;
export const OAUTH_GRANT_AGE_BUCKET_ATTRIBUTE =
  "app.access.grant.age_bucket" as const;
export const OAUTH_GRANT_REVOKED_REASON_ATTRIBUTE =
  "app.access.grant.revoked_reason" as const;
export const OAUTH_UPSTREAM_EXPIRES_IN_BUCKET_ATTRIBUTE =
  "app.access.upstream.expires_in_bucket" as const;
export const OAUTH_PROBE_STATUS_CODE_ATTRIBUTE =
  "app.access.probe.status_code" as const;
export const OAUTH_PROBE_REASON_ATTRIBUTE = "app.access.probe.reason" as const;

/**
 * Low-cardinality OAuth client registration method.
 * CIMD clients present an HTTPS URL as client_id; DCR clients receive an
 * opaque registered client_id from /oauth/register.
 */
export const CLIENT_REGISTRATION_METHOD_ATTRIBUTE =
  "app.client.registration.method" as const;

export type ClientRegistrationMethod = "cimd" | "dcr" | "unknown";

/**
 * Classifies an OAuth client_id as CIMD, DCR, or unknown without emitting
 * the raw client_id. HTTPS URL client_ids are CIMD; opaque non-URL ids are
 * treated as DCR under the current server client model.
 */
export function resolveClientRegistrationMethod(
  clientId: unknown,
): ClientRegistrationMethod {
  if (typeof clientId !== "string") {
    return "unknown";
  }

  const trimmed = clientId.trim();
  if (!trimmed) {
    return "unknown";
  }

  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? "cimd" : "unknown";
  } catch {
    return "dcr";
  }
}

/**
 * Returns the bounded client-registration-method attribute for metrics,
 * spans, and logs.
 */
export function getClientRegistrationMethodTelemetry(
  clientId: unknown,
): Record<
  typeof CLIENT_REGISTRATION_METHOD_ATTRIBUTE,
  ClientRegistrationMethod
> {
  return {
    [CLIENT_REGISTRATION_METHOD_ATTRIBUTE]:
      resolveClientRegistrationMethod(clientId),
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function getTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bucketElapsedMs(value: unknown, now = Date.now()): string {
  const timestamp = getTimestamp(value);
  if (!timestamp) {
    return "unknown";
  }

  const elapsedMs = now - timestamp;
  if (elapsedMs < 0) {
    return "future";
  }
  if (elapsedMs < HOUR_MS) {
    return "lt_1h";
  }
  if (elapsedMs < 6 * HOUR_MS) {
    return "1h_6h";
  }
  if (elapsedMs < DAY_MS) {
    return "6h_1d";
  }
  if (elapsedMs < 7 * DAY_MS) {
    return "1d_7d";
  }
  if (elapsedMs < 14 * DAY_MS) {
    return "7d_14d";
  }
  if (elapsedMs < 30 * DAY_MS) {
    return "14d_30d";
  }
  return "gte_30d";
}

function bucketRemainingMs(value: unknown, now = Date.now()): string {
  const timestamp = getTimestamp(value);
  if (!timestamp) {
    return "unknown";
  }

  const remainingMs = timestamp - now;
  if (remainingMs <= 0) {
    return "expired";
  }
  if (remainingMs < HOUR_MS) {
    return "lt_1h";
  }
  if (remainingMs < DAY_MS) {
    return "1h_1d";
  }
  if (remainingMs < 7 * DAY_MS) {
    return "1d_7d";
  }
  if (remainingMs < 14 * DAY_MS) {
    return "7d_14d";
  }
  if (remainingMs < 30 * DAY_MS) {
    return "14d_30d";
  }
  return "gte_30d";
}

/**
 * Projects OAuth grant lifecycle timestamps into bounded diagnostic buckets.
 */
export function getOAuthGrantLifecycleTelemetry(props: {
  sessionStartedAt?: unknown;
  upstreamExpiresAt?: unknown;
}): Record<string, string> {
  return {
    [OAUTH_GRANT_AGE_BUCKET_ATTRIBUTE]: bucketElapsedMs(props.sessionStartedAt),
    [OAUTH_UPSTREAM_EXPIRES_IN_BUCKET_ATTRIBUTE]: bucketRemainingMs(
      props.upstreamExpiresAt,
    ),
  };
}

/**
 * Buckets OAuth error codes before they become span or metric attributes.
 */
export function bucketOAuthErrorCode(
  value: unknown,
): OAuthErrorCode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.toLowerCase().replace(/[^a-z0-9_]/g, "_");

  switch (normalized) {
    case "invalid_request":
    case "invalid_client":
    case "invalid_grant":
    case "invalid_target":
    case "unsupported_grant_type":
    case "invalid_client_metadata":
    case "not_implemented":
      return normalized;
    case "invalid_token":
      // Scrubber-safe: avoid emitting token/bearer substrings.
      return "invalid_access";
    default:
      return normalized ? "other" : undefined;
  }
}

/**
 * Buckets OAuth error descriptions into stable diagnostic categories.
 */
export function bucketOAuthErrorDescription(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.toLowerCase();

  // Bucket values deliberately avoid token/bearer/auth/credentials substrings.
  if (normalized.includes("missing or invalid access token")) {
    return "missing_or_invalid_access";
  }
  if (normalized.includes("missing, invalid, or expired access token")) {
    return "missing_invalid_or_expired_access";
  }
  if (normalized.includes("invalid access token")) {
    return "invalid_access";
  }
  if (normalized.includes("access token expired")) {
    return "access_expired";
  }
  if (normalized.includes("audience does not match")) {
    return "access_audience_mismatch";
  }
  if (normalized.includes("grant not found")) {
    return "grant_not_found";
  }
  if (normalized.includes("invalid refresh token")) {
    return "invalid_refresh";
  }
  if (normalized.includes("content-type")) {
    return "invalid_content_type";
  }
  if (normalized.includes("client id is required")) {
    return "missing_client_id";
  }

  return "other";
}

function parseAuthenticateParams(
  headerValue: string | null,
): Record<string, string> {
  if (!headerValue) {
    return {};
  }

  const match = headerValue.match(AUTH_CHALLENGE);
  if (!match) {
    return {};
  }

  const [, , params = ""] = match;
  const parsed: Record<string, string> = {};

  for (const part of params.split(AUTH_PARAM_SEPARATOR)) {
    const [rawKey, ...rawValueParts] = part.split("=");
    const key = rawKey?.trim().toLowerCase();
    if (!key || rawValueParts.length === 0) {
      continue;
    }

    const rawValue = rawValueParts.join("=").trim();
    parsed[key] = rawValue.replace(/^"|"$/g, "");
  }

  return parsed;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function parseResponseJsonBody(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return null;
  }

  try {
    return parseJsonObject(await response.clone().text());
  } catch {
    return null;
  }
}

/**
 * Classifies the bearer token shape without exposing the token value.
 */
export function getOAuthBearerShape(request: Request): OAuthBearerShape {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return "missing";
  }

  const match = authHeader.match(/^Bearer\s*(.*)$/i);
  if (!match) {
    return "non_scheme";
  }

  const token = match[1]?.trim();
  if (!token) {
    return "empty_scheme";
  }

  const parts = token.split(":");
  if (parts.length === 3 && parts.every(Boolean)) {
    return "wrapper";
  }

  return "malformed";
}

function fingerprintOAuthGrantId(grantId: string): string {
  let hash = 0x811c9dc5;

  for (let i = 0; i < grantId.length; i++) {
    hash ^= grantId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Projects a grant ID into non-secret log fields for session correlation.
 */
export function getOAuthGrantTelemetry(
  grantId: string | null,
): Record<string, string> {
  return grantId
    ? { [OAUTH_GRANT_ID_HASH_ATTRIBUTE]: fingerprintOAuthGrantId(grantId) }
    : {};
}

/**
 * Extracts best-effort OAuth error telemetry from an error response.
 */
export async function getOAuthErrorTelemetry(
  request: Request,
  response: Response,
): Promise<OAuthErrorTelemetry> {
  const telemetry: OAuthErrorTelemetry = {};

  if (response.status === 401) {
    telemetry.oauthBearerShape = getOAuthBearerShape(request);
  }

  const authenticateParams = parseAuthenticateParams(
    response.headers.get("WWW-Authenticate"),
  );
  const headerError = bucketOAuthErrorCode(authenticateParams.error);
  if (headerError) {
    telemetry.oauthError = headerError;
    telemetry.oauthErrorReason = bucketOAuthErrorDescription(
      authenticateParams.error_description,
    );
    if (!telemetry.oauthErrorReason) {
      const json = await parseResponseJsonBody(response);
      telemetry.oauthErrorReason = bucketOAuthErrorDescription(
        json?.error_description,
      );
    }
    return telemetry;
  }

  const json = await parseResponseJsonBody(response);
  if (!json) {
    return telemetry;
  }

  const bodyError = bucketOAuthErrorCode(json.error);
  if (!bodyError) {
    return telemetry;
  }

  telemetry.oauthError = bodyError;
  telemetry.oauthErrorReason = bucketOAuthErrorDescription(
    json.error_description,
  );
  return telemetry;
}
