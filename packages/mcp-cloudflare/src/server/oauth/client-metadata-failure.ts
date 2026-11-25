import type { CimdFetchError } from "@cloudflare/workers-oauth-provider";

/**
 * CIMD discovery failure (draft-ietf-oauth-client-id-metadata-document §6.1).
 * Transient failures may succeed on retry; terminal failures need the client
 * to fix its Client ID Metadata Document.
 */
type ClientMetadataFailure = {
  failureClass: "transient" | "terminal";
  reason:
    | "http_status"
    | "timeout"
    | "too_large"
    | "invalid_document"
    | "invalid_metadata"
    | "invalid_client_id";
  status?: number;
};

// Messages thrown by @cloudflare/workers-oauth-provider while fetching and
// validating a metadata document. CimdFetchError exposes only the message, so
// these must be checked when upgrading the provider; unmatched messages are
// not classified and keep reaching Sentry.
const HTTP_STATUS_PATTERN = /^Failed to fetch client metadata: HTTP (\d{3})$/;
const TIMEOUT_PATTERN = /^Client metadata fetch timed out after \d+ms$/;
const TOO_LARGE_PATTERN =
  /^(?:Client metadata exceeds size limit|Response exceeded size limit)\b/;
const INVALID_DOCUMENT_PATTERN =
  /^Client metadata response (?:is not valid JSON|is not valid UTF-8|body is empty)$/;
const INVALID_CLIENT_ID_PATTERN = /^Client Identifier URL /;
const INVALID_METADATA_PATTERNS = [
  /^client_id ".*" does not match metadata URL/,
  /^Client metadata must be a JSON object$/,
  /^Invalid [a-z_]+: /,
  /^Invalid redirect URI$/,
  /^(?:client_name|redirect_uris) is required and must not be empty$/,
  /^[a-z_]+ must be included in [a-z_]+$/,
  /^Unsupported (?:token_endpoint_auth_method|grant_type|response_type): /,
  /^grant_types [a-z_]+ and response_types [a-z_]+ must be registered together$/,
  /^CIMD documents must not contain /,
  /^CIMD clients cannot use /,
  /^CIMD client does not support an accepted token endpoint authentication method\b/,
];

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Classifies why a CIMD client's metadata could not be resolved. Returns
 * undefined for failures that are not known metadata problems, such as fetch
 * runtime errors, so callers can keep reporting them.
 */
export function classifyClientMetadataFailure(
  error: CimdFetchError,
): ClientMetadataFailure | undefined {
  const { detail } = error;

  const statusMatch = HTTP_STATUS_PATTERN.exec(detail);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return {
      failureClass: isTransientStatus(status) ? "transient" : "terminal",
      reason: "http_status",
      status,
    };
  }
  if (TIMEOUT_PATTERN.test(detail)) {
    return { failureClass: "transient", reason: "timeout" };
  }
  if (TOO_LARGE_PATTERN.test(detail)) {
    return { failureClass: "terminal", reason: "too_large" };
  }
  if (INVALID_DOCUMENT_PATTERN.test(detail)) {
    return { failureClass: "terminal", reason: "invalid_document" };
  }
  if (INVALID_CLIENT_ID_PATTERN.test(detail)) {
    return { failureClass: "terminal", reason: "invalid_client_id" };
  }
  if (INVALID_METADATA_PATTERNS.some((pattern) => pattern.test(detail))) {
    return { failureClass: "terminal", reason: "invalid_metadata" };
  }
  return undefined;
}
