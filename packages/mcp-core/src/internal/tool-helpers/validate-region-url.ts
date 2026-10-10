import { isSaaSTrustOrigin } from "@sentry/toolkit-core/sentry-origin";
import { UserInputError } from "../../errors";
import { SENTRY_ALLOWED_REGION_DOMAINS } from "../../constants";

/**
 * Validates that a regionUrl is valid.
 * Prevents SSRF attacks by only allowing the base host itself or domains from an allowlist.
 *
 * Rules:
 * 1. By default, only the base host itself is allowed as regionUrl
 * 2. For other domains, they must be in SENTRY_ALLOWED_REGION_DOMAINS
 * 3. Protocol MUST be HTTPS for security
 *
 * @param regionUrl - The region URL to validate
 * @param baseHost - The base host to validate against
 * @returns The validated host if valid
 * @throws {UserInputError} If the regionUrl is invalid or not allowed
 */
export function validateRegionUrl(regionUrl: string, baseHost: string): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(regionUrl);
  } catch {
    throw new UserInputError(
      "Invalid regionUrl provided. Must be a valid URL.",
    );
  }

  // Validate protocol - MUST be HTTPS for security
  if (parsedUrl.protocol !== "https:") {
    throw new UserInputError(
      "Invalid regionUrl provided. Must use HTTPS protocol for security.",
    );
  }

  // Validate that the host is not just the protocol name
  if (parsedUrl.host === "https" || parsedUrl.host === "http") {
    throw new UserInputError(
      "Invalid regionUrl provided. The host cannot be just a protocol name.",
    );
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new UserInputError(
      "Invalid regionUrl provided. URL credentials are not allowed.",
    );
  }

  const regionHost = parsedUrl.host.toLowerCase();
  const baseLower = baseHost.toLowerCase();

  // First, allow if it's the same as the base host
  if (regionHost === baseLower) {
    return regionHost;
  }

  // Otherwise, check against the allowlist
  if (
    !SENTRY_ALLOWED_REGION_DOMAINS.has(regionHost) ||
    !isSaaSTrustOrigin(regionUrl)
  ) {
    throw new UserInputError(
      `Invalid regionUrl. The domain '${regionHost}' is not allowed. Allowed domains are: ${Array.from(SENTRY_ALLOWED_REGION_DOMAINS).join(", ")}`,
    );
  }

  return regionHost;
}
