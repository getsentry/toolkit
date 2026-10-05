/**
 * Shared Hex ID Validation
 *
 * Central place for hexadecimal identifier primitives used across the CLI:
 * regex patterns, normalization, validation, UUIDv7 timestamp decoding,
 * and the `HexEntityType` discriminator that other modules key off.
 * All callers — including `hex-id-recovery.ts` — should import from here
 * rather than rolling their own patterns.
 */

import { ValidationError } from "./errors.js";

/**
 * Entity types whose identifiers are 32- or 16-char hex strings.
 *
 * Lives in this low-level module so higher-level modules (`retention.ts`,
 * `hex-id-recovery.ts`) can depend on it without creating a circular
 * type dependency in the other direction.
 */
export type HexEntityType = "event" | "trace" | "log" | "span";

// ---------------------------------------------------------------------------
// Anchored patterns (match a complete string)
// ---------------------------------------------------------------------------

/** Regex for a valid 32-character hexadecimal ID */
export const HEX_ID_RE = /^[0-9a-f]{32}$/i;

/** Regex for a valid 16-character hexadecimal span ID */
export const SPAN_ID_RE = /^[0-9a-f]{16}$/i;

/**
 * Regex for UUID format with dashes: 8-4-4-4-12 hex groups.
 * Users often copy trace/log IDs from tools that display them in UUID format.
 * Stripping the dashes yields a valid 32-character hex ID.
 */
export const UUID_DASH_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Any-length pure hex string (case-insensitive). */
export const PURE_HEX_RE = /^[0-9a-f]+$/i;

// ---------------------------------------------------------------------------
// Prefix / fragment patterns (unanchored)
// ---------------------------------------------------------------------------

/** Longest leading run of lowercase hex digits (no anchor at end). */
export const LEADING_HEX_RE = /^[0-9a-f]+/;

/** First char of a string is a hex digit. */
export const LEADING_HEX_CHAR_RE = /^[0-9a-f]/;

/**
 * Middle-ellipsis pattern used in CLI output and some external tools:
 * `<hex>...<hex>` or `<hex>…<hex>` (unicode horizontal ellipsis).
 * Captures the hex prefix and suffix groups.
 */
export const MIDDLE_ELLIPSIS_RE = /^([0-9a-f]*)(?:\.\.\.|…)([0-9a-f]*)$/;

/** Segment with 2+ alphabetic chars — used in slug heuristics. */
export const ALPHA_SEGMENT_RE = /[a-z]{2,}/i;

// ---------------------------------------------------------------------------
// Other patterns used by validateHexId for error-hint classification
// ---------------------------------------------------------------------------

/** Max display length for invalid IDs in error messages before truncation */
const MAX_DISPLAY_LENGTH = 40;

/** Matches any character that is NOT a lowercase hex digit. */
export const NON_HEX_RE = /[^0-9a-f]/;

/** Matches strings starting with a dash — likely CLI flags that Stricli didn't recognize */
const FLAG_LIKE_RE = /^-/;

/** Matches common help flag typos (e.g., "--h", "-h", "--help", "-help") */
const HELP_FLAG_RE = /^--?h(elp)?$/;

/** Global dash stripper (used internally for dash removal, not a match). */
const DASH_GLOBAL_RE = /-/g;

/**
 * Normalize a potential hex ID: trim, lowercase, strip UUID dashes.
 * Does NOT validate — call this before checking {@link HEX_ID_RE}.
 *
 * Extracted so that both {@link validateHexId} and non-throwing predicates
 * (like `isTraceId`) share identical normalization logic.
 *
 * @param value - The raw string to normalize
 * @returns The trimmed, lowercased string with UUID dashes stripped if applicable
 */
export function normalizeHexId(value: string): string {
  let trimmed = value.trim().toLowerCase();
  if (UUID_DASH_RE.test(trimmed)) {
    trimmed = trimmed.replace(DASH_GLOBAL_RE, "");
  }
  return trimmed;
}

/**
 * Non-throwing variant of {@link normalizeHexId} that returns `undefined`
 * for falsy input or input that doesn't normalize to a valid 32-char hex ID.
 *
 * Useful when the caller wants to silently discard invalid IDs (e.g.,
 * collecting replay IDs from event tags where bad values are expected).
 *
 * @param value - Raw string, or null/undefined
 * @returns Normalized 32-char lowercase hex ID, or undefined
 */
export function tryNormalizeHexId(
  value: string | null | undefined
): string | undefined {
  if (!value) {
    return;
  }

  const normalized = normalizeHexId(value.trim());
  return HEX_ID_RE.test(normalized) ? normalized : undefined;
}

/**
 * Validate that a string is a 32-character hexadecimal ID.
 * Trims whitespace and normalizes to lowercase before validation.
 *
 * When the input matches UUID format (8-4-4-4-12 hex with dashes), the dashes
 * are automatically stripped. This is a common copy-paste mistake — the
 * underlying hex content is valid, just formatted differently.
 *
 * Normalization to lowercase ensures consistent comparison with API responses,
 * which return lowercase hex IDs regardless of input casing.
 *
 * Returns the trimmed, lowercased, validated ID so it can be used as a Stricli
 * `parse` function directly.
 *
 * @param value - The string to validate
 * @param label - Human-readable name for error messages (e.g., "log ID", "trace ID")
 * @returns The trimmed, lowercased, validated ID
 * @throws {ValidationError} If the format is invalid
 */
export function validateHexId(value: string, label: string): string {
  const normalized = normalizeHexId(value);

  if (!HEX_ID_RE.test(normalized)) {
    const display =
      normalized.length > MAX_DISPLAY_LENGTH
        ? `${normalized.slice(0, MAX_DISPLAY_LENGTH - 3)}...`
        : normalized;

    let message =
      `Invalid ${label} "${display}". Expected a 32-character hexadecimal string.\n\n` +
      "Example: abc123def456abc123def456abc123de";

    // Detect common misidentified entity types and add helpful hints.
    // Flag-like check first — strings starting with "-" are almost certainly
    // CLI flags that Stricli didn't recognize (e.g., "--h" instead of "-h").
    if (FLAG_LIKE_RE.test(normalized)) {
      if (HELP_FLAG_RE.test(normalized)) {
        message +=
          "\n\nThis looks like a help flag. Use --help or -h for help.";
      } else {
        message +=
          "\n\nThis looks like a CLI flag, not a hex ID. Check flag syntax with --help.";
      }
    } else if (SPAN_ID_RE.test(normalized)) {
      // 16-char hex looks like a span ID
      message +=
        "\n\nThis looks like a span ID (16 characters). " +
        `If you have the trace ID, try: sentry span view <trace-id> ${display}`;
    } else if (NON_HEX_RE.test(normalized)) {
      // Contains non-hex characters — likely a slug, name, or truncated input.
      // The hex-id-recovery module at the command layer provides more specific
      // hints (sentinel leak, slug detection, prefix lookup) when wired in;
      // this is the generic fallback surfaced by paths that don't use recovery.
      message +=
        `\n\nThis doesn't look like a hex ID. If it is a name or slug, ` +
        `pass it as a target: <org>/<project> <${label}>`;
    }

    throw new ValidationError(message);
  }

  return normalized;
}

/**
 * Validate that a string is a 16-character hexadecimal span ID.
 * Trims whitespace and normalizes to lowercase before validation.
 *
 * Dashes are stripped automatically so users can paste IDs in dash-separated
 * formats (e.g., from debugging tools that format span IDs with dashes).
 *
 * @param value - The string to validate
 * @returns The trimmed, lowercased, validated span ID
 * @throws {ValidationError} If the format is invalid
 */
export function validateSpanId(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(DASH_GLOBAL_RE, "");

  if (!SPAN_ID_RE.test(trimmed)) {
    const display =
      trimmed.length > MAX_DISPLAY_LENGTH
        ? `${trimmed.slice(0, MAX_DISPLAY_LENGTH - 3)}...`
        : trimmed;

    let message =
      `Invalid span ID "${display}". Expected a 16-character hexadecimal string.\n\n` +
      "Example: a1b2c3d4e5f67890";

    // Detect 32-char hex (trace/log ID) passed as span ID
    if (HEX_ID_RE.test(trimmed)) {
      message +=
        "\n\nThis looks like a trace ID (32 characters), not a span ID.";
    }

    throw new ValidationError(message);
  }

  return trimmed;
}

// ---------------------------------------------------------------------------
// UUIDv7 timestamp decoding
//
// Sentry log IDs (and some future trace/event IDs) are UUIDv7, which embeds
// a millisecond-precision Unix timestamp in the first 48 bits. When we can
// decode a timestamp we can speak with certainty about retention ("created
// 147 days ago — past the 90-day log retention window") instead of hedging
// with "may have been deleted".
//
// UUIDv7 layout (after dash stripping):
//   tttttttttttt  — 48 bits of milliseconds since Unix epoch (12 hex chars)
//   7vvv           — 4 bits version (`7`) + 12 bits random
//   yxxx           — 2 bits variant (binary 10, so first hex is 8/9/a/b) + 14 bits random
//   xxxxxxxxxxxx  — 48 bits random
// ---------------------------------------------------------------------------

/** Version nibble position in a dash-stripped 32-char UUID. */
const UUID_VERSION_INDEX = 12;

/** UUIDv7 version character. */
const UUID_V7 = "7";

/**
 * Decode a UUIDv7 (or any v7-prefixed 32-hex) into its embedded timestamp.
 *
 * Accepts either a dash-separated UUID (`xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx`)
 * or the dash-stripped 32-hex form. Returns `null` when the input isn't a
 * version-7 UUID — callers should treat `null` as "can't make claims about
 * this ID's age" and fall back to generic messaging.
 *
 * The returned `Date` is in UTC. Sub-millisecond precision is NOT preserved;
 * UUIDv7 reserves ~12 bits for sub-ms rand/sequence but Sentry doesn't use
 * those bits for time, so decoding only the high 48 bits is correct.
 *
 * @param value - Raw UUID string (with or without dashes)
 * @returns `{ createdAt }` when the value is UUIDv7, else `null`
 */
export function decodeUuidV7Timestamp(
  value: string
): { createdAt: Date } | null {
  const normalized = normalizeHexId(value);
  if (!HEX_ID_RE.test(normalized)) {
    return null;
  }
  if (normalized[UUID_VERSION_INDEX] !== UUID_V7) {
    return null;
  }
  const timestampHex = normalized.slice(0, UUID_VERSION_INDEX);
  const ms = Number.parseInt(timestampHex, 16);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return { createdAt: new Date(ms) };
}

/**
 * Compute the age in days of a UUIDv7 creation timestamp relative to `now`.
 * Returns `null` when the value isn't a UUIDv7.
 */
export function ageInDaysFromUuidV7(
  value: string,
  now: Date = new Date()
): number | null {
  const decoded = decodeUuidV7Timestamp(value);
  if (!decoded) {
    return null;
  }
  const diffMs = now.getTime() - decoded.createdAt.getTime();
  return diffMs / (24 * 60 * 60 * 1000);
}
