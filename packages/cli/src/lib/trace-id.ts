/**
 * Trace ID Validation
 *
 * Re-exports shared hex ID validation specialized for trace IDs.
 * Used by `trace logs`, `log list`, and `span list` commands.
 */

import { HEX_ID_RE, normalizeHexId, validateHexId } from "./hex-id.js";

/**
 * Regex for a valid 32-character hexadecimal trace ID.
 * Alias for `HEX_ID_RE` — both trace IDs and log IDs share the same format.
 */
export const TRACE_ID_RE = HEX_ID_RE;

/**
 * Non-throwing check: does the string look like a valid 32-char hex trace ID?
 *
 * Handles UUID-dash format (8-4-4-4-12) and whitespace trimming, matching
 * the same normalization as {@link validateTraceId}. Use this when you need
 * to disambiguate between a trace ID and another kind of identifier (e.g.,
 * a project slug) without throwing.
 *
 * @param value - The string to test
 * @returns `true` if the value would pass {@link validateTraceId}
 */
export function isTraceId(value: string): boolean {
  return HEX_ID_RE.test(normalizeHexId(value));
}

/**
 * Validate that a string looks like a 32-character hex trace ID.
 *
 * Returns the validated trace ID so it can be used as a Stricli `parse`
 * function directly.
 *
 * @param traceId - The trace ID string to validate
 * @returns The validated trace ID (trimmed)
 * @throws {ValidationError} If the trace ID format is invalid
 */
export function validateTraceId(traceId: string): string {
  return validateHexId(traceId, "trace ID");
}
