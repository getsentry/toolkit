/**
 * Input Validation for Agent Hallucination Hardening
 *
 * Reusable validators that defend against malformed inputs from AI agents.
 * Agents hallucinate differently than humans typo — they embed query params
 * in resource IDs, double-encode URLs, and inject path traversals.
 *
 * These validators are applied at the CLI argument parsing layer so all
 * commands benefit automatically. The Sentry API handles most of these
 * server-side (404, 400), but client-side validation provides:
 * - Better error messages with actionable suggestions
 * - Faster failure without a network round-trip
 * - Defense-in-depth against unexpected URL manipulation
 *
 * @see https://github.com/getsentry/cli/issues/350
 */

import { ValidationError } from "./errors.js";

/**
 * Characters that are never valid in Sentry resource identifiers (slugs, IDs).
 * These would cause URL injection if interpolated into API paths.
 *
 * - `?` — query string injection
 * - `#` — fragment injection
 * - `%` — pre-URL-encoded values (double-encoding risk)
 * - whitespace — breaks URL structure
 */
const RESOURCE_ID_FORBIDDEN = /[?#%\s]/;

/**
 * Matches `%XX` hex-encoded sequences (e.g., `%2F`, `%20`, `%3A`).
 * Used to detect pre-encoded strings that would get double-encoded.
 */
const PRE_ENCODED_PATTERN = /%[0-9a-fA-F]{2}/;

/**
 * Matches ASCII control characters (code points 0x00–0x1F).
 * These are invisible and have no valid use in CLI string inputs.
 *
 * Built via RegExp constructor to avoid lint warnings about literal
 * control characters in regex patterns.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars for input validation
const CONTROL_CHAR_PATTERN = /[\x00-\x1f]/;

/**
 * Matches literal or percent-encoded `..` path segments.
 * Anchored to segment boundaries (start/end of string or `/`).
 */
const PATH_TRAVERSAL_PATTERN = /(^|\/)(?:\.|%2e){2}(\/|$)/i;

/**
 * Human-readable descriptions for the first forbidden character found.
 * Provides clear context in error messages.
 */
function describeForbiddenChar(char: string): string {
  const code = char.charCodeAt(0);

  if (char === "?") {
    return '"?" (query string)';
  }
  if (char === "#") {
    return '"#" (URL fragment)';
  }
  if (char === "%") {
    return '"%" (URL encoding)';
  }
  if (char === " ") {
    return "a space";
  }
  if (char === "\t") {
    return "a tab character";
  }
  if (char === "\n") {
    return "a newline";
  }
  if (char === "\r") {
    return "a carriage return";
  }
  if (char === "\0") {
    return "a null byte";
  }
  // Generic control character
  if (code < 0x20) {
    return `control character (0x${code.toString(16).padStart(2, "0")})`;
  }
  // Other whitespace
  return `whitespace character (U+${code.toString(16).padStart(4, "0")})`;
}

/**
 * Reject ASCII control characters (below 0x20) in any string input.
 *
 * Control characters are invisible and have no valid use in CLI arguments.
 * An agent could embed them to manipulate downstream processing.
 *
 * @param input - String to validate
 * @param label - Human-readable name for error messages (e.g., "organization slug")
 * @throws {ValidationError} When input contains control characters
 */
export function rejectControlChars(input: string, label: string): void {
  const match = CONTROL_CHAR_PATTERN.exec(input);
  if (match) {
    const capitalizedLabel = label.charAt(0).toUpperCase() + label.slice(1);
    throw new ValidationError(
      `Invalid ${label}: contains ${describeForbiddenChar(match[0])}.\n` +
        `  ${capitalizedLabel} must not contain control characters.`
    );
  }
}

/**
 * Reject pre-URL-encoded sequences (`%XX`) in resource identifiers.
 *
 * Resource IDs (slugs, issue IDs) should always be plain strings. If they
 * contain `%XX` patterns, they were likely pre-encoded by an agent and
 * would get double-encoded when interpolated into API URLs.
 *
 * @param input - String to validate
 * @param label - Human-readable name for error messages (e.g., "project slug")
 * @throws {ValidationError} When input contains percent-encoded sequences
 */
export function rejectPreEncoded(input: string, label: string): void {
  const match = PRE_ENCODED_PATTERN.exec(input);
  if (match) {
    throw new ValidationError(
      `Invalid ${label}: contains URL-encoded sequence "${match[0]}".\n` +
        `  Use plain text instead of percent-encoding (e.g., "my project" not "my%20project").`
    );
  }
}

/**
 * Validate a resource identifier (org slug, project slug, or issue ID component).
 *
 * Rejects characters that would cause URL injection when the identifier
 * is interpolated into API endpoint paths. This is the primary defense
 * against agent-hallucinated inputs like:
 * - `my-org?query=foo` (query injection)
 * - `my-project#anchor` (fragment injection)
 * - `CLI-G%20extra` (pre-encoded space → double encoding)
 * - `my-org\tother` (control character injection)
 *
 * @param input - Resource identifier to validate
 * @param label - Human-readable name for error messages (e.g., "organization slug")
 * @throws {ValidationError} When input contains forbidden characters
 */
export function validateResourceId(input: string, label: string): void {
  // Check control characters first (subset of the broader check)
  rejectControlChars(input, label);

  // Check for URL-significant characters and whitespace
  const match = RESOURCE_ID_FORBIDDEN.exec(input);
  if (match) {
    throw new ValidationError(
      `Invalid ${label}: contains ${describeForbiddenChar(match[0])}.\n` +
        "  Slugs and IDs must contain only letters, numbers, hyphens, and underscores."
    );
  }
}

/**
 * Validate an API endpoint path for path traversal attacks.
 *
 * Rejects `..` path segments that could be used to escape the API prefix:
 * ```
 * sentry api "../../admin/settings/"  →  rejected
 * sentry api "organizations/../admin" →  rejected
 * ```
 *
 * While the Sentry API server handles this safely (404), rejecting on the
 * client provides better error messages and defense-in-depth.
 *
 * Also validates that the endpoint doesn't contain control characters.
 *
 * @param endpoint - API endpoint path to validate
 * @throws {ValidationError} When endpoint contains path traversal or control characters
 */
export function validateEndpoint(endpoint: string): void {
  rejectControlChars(endpoint, "API endpoint");

  if (PATH_TRAVERSAL_PATTERN.test(endpoint)) {
    throw new ValidationError(
      'Invalid API endpoint: contains ".." path traversal.\n' +
        "  Use absolute API paths (e.g., /api/0/organizations/my-org/issues/)."
    );
  }
}
