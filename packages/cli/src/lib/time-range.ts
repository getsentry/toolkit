/**
 * Time range parsing and conversion for the --period flag.
 *
 * Supports three syntaxes:
 * 1. Relative durations: "7d", "24h", "1h", "30m", "2w"
 * 2. Date ranges with ".." separator: "2024-01-01..2024-02-01", "2024-01-01..", "..2024-02-01"
 * 3. Comparison operators (gh-compatible): ">2024-01-01", ">=2024-01-01", "<2024-02-01", "<=2024-02-01"
 *
 * Date-only inputs are normalized using the local machine timezone.
 * Datetimes with explicit timezone offsets are passed through as-is.
 */

import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Relative duration like "7d", "24h" */
export type RelativeTimeRange = {
  readonly type: "relative";
  /** Raw duration string passed through to the API's statsPeriod param */
  readonly period: string;
};

/** Absolute date range with optional open ends */
export type AbsoluteTimeRange = {
  readonly type: "absolute";
  /** ISO-8601 datetime string, or undefined for open-ended start */
  readonly start?: string;
  /** ISO-8601 datetime string, or undefined for open-ended end */
  readonly end?: string;
};

/** Discriminated union for all period flag values */
export type TimeRange = RelativeTimeRange | AbsoluteTimeRange;

/** API parameters for time-scoped queries — statsPeriod and start/end are mutually exclusive */
export type TimeRangeApiParams = {
  statsPeriod?: string;
  start?: string;
  end?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Seconds per unit for relative period computation. @internal Exported for reuse in duration parsers. */
export const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
};

/** Valid unit suffixes for relative period strings, derived from UNIT_SECONDS */
const PERIOD_UNITS = new Set(Object.keys(UNIT_SECONDS));

/** Stable example dates keep generated help and skill references reproducible. */
const EXAMPLE_START = "2024-01-01";
const EXAMPLE_END = "2024-02-01";

/** Brief text for --period flag help, shared across commands */
export const PERIOD_BRIEF = `Time range: "7d", "${EXAMPLE_START}..${EXAMPLE_END}", ">=${EXAMPLE_START}"`;

/**
 * Try to parse a relative period string (e.g., "7d") into its numeric value and unit.
 * Returns null if the string isn't a valid relative period.
 */
export function parseRelativeParts(
  value: string,
): { value: number; unit: string } | null {
  if (value.length < 2) {
    return null;
  }
  const unit = value.at(-1) as string;
  if (!PERIOD_UNITS.has(unit)) {
    return null;
  }
  const numStr = value.slice(0, -1);
  const num = Number(numStr);
  if (!Number.isInteger(num) || num < 0 || numStr.length === 0) {
    return null;
  }
  return { value: num, unit };
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/**
 * Date normalization positions.
 *
 * - "start": inclusive start boundary (>= semantics). Date-only → local midnight.
 * - "end": inclusive end boundary (<= semantics). Date-only → local end-of-day.
 * - "after": exclusive start boundary (> semantics). Date-only → next day local midnight.
 * - "before": exclusive end boundary (< semantics). Date-only → previous day local end-of-day.
 */
type DatePosition = "start" | "end" | "after" | "before";

/**
 * Validate a date string with `new Date()` and return the parsed Date.
 * @throws ValidationError on invalid input
 */
function validateDate(raw: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError(
      `Invalid date: '${raw}'. Expected ISO-8601 format (e.g., ${EXAMPLE_START} or ${EXAMPLE_START}T12:00:00).`,
      "period",
    );
  }
  return d;
}

/**
 * Parse and normalize a date string based on its position in a range expression.
 *
 * All outputs are UTC ISO-8601 strings (via `.toISOString()`).
 * - Date-only inputs are interpreted as local time (JS treats `new Date("2024-01-15T00:00:00")`
 *   without "Z" as local), then converted to UTC.
 * - Datetime inputs with explicit timezone are parsed natively by `new Date()`.
 * - Datetime inputs without timezone are treated as local time by `new Date()`.
 *
 * @throws ValidationError on invalid date input
 */
export function parseDate(raw: string, position: DatePosition): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(
      `Empty date value. Expected ISO-8601 format (e.g., ${EXAMPLE_START})`,
      "period",
    );
  }

  // Normalize space-separated datetime to ISO "T" separator (common user input)
  const normalized = trimmed.includes(" ")
    ? trimmed.replace(" ", "T")
    : trimmed;

  // Date-only (no "T"): apply position-aware time boundaries in local time
  if (!normalized.includes("T")) {
    return normalizeDateOnly(normalized, position);
  }

  // Datetime: validate and convert to UTC
  return validateDate(normalized).toISOString();
}

/**
 * Normalize a date-only string (YYYY-MM-DD) with position-aware boundaries.
 *
 * Constructs datetimes without "Z" so `new Date()` interprets them as local time,
 * then converts to UTC via `.toISOString()`.
 *
 * Day arithmetic for "after"/"before" uses local Date methods (setDate/setHours)
 * to avoid UTC/local mismatches in extreme timezones.
 */
function normalizeDateOnly(dateStr: string, position: DatePosition): string {
  // Validate the date is parseable
  validateDate(`${dateStr}T12:00:00`);

  if (position === "start") {
    return new Date(`${dateStr}T00:00:00`).toISOString();
  }
  if (position === "end") {
    return new Date(`${dateStr}T23:59:59.999`).toISOString();
  }
  if (position === "after") {
    // Exclusive start (>): next day's local midnight.
    // Use local Date methods throughout to avoid UTC/local day mismatch.
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  // position === "before": Exclusive end (<): previous day's local end-of-day.
  const d = new Date(`${dateStr}T23:59:59.999`);
  d.setDate(d.getDate() - 1);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Try to parse a comparison operator prefix (>=, >, <=, <).
 * Returns the parsed TimeRange or null if the value doesn't start with an operator.
 */
function tryParseOperator(value: string): AbsoluteTimeRange | null {
  const operators: Array<{
    prefix: string;
    position: DatePosition;
    field: "start" | "end";
  }> = [
    { prefix: ">=", position: "start", field: "start" },
    { prefix: ">", position: "after", field: "start" },
    { prefix: "<=", position: "end", field: "end" },
    { prefix: "<", position: "before", field: "end" },
  ];

  for (const op of operators) {
    if (!value.startsWith(op.prefix)) {
      continue;
    }
    const dateStr = value.slice(op.prefix.length);
    if (dateStr.length === 0) {
      throw new ValidationError(
        `Missing date after '${op.prefix}'. Expected e.g., '${op.prefix}${EXAMPLE_START}'.`,
        "period",
      );
    }
    const parsed = parseDate(dateStr, op.position);
    return {
      type: "absolute",
      [op.field]: parsed,
    } as AbsoluteTimeRange;
  }

  return null;
}

/**
 * Try to parse a ".." range expression.
 * Returns the parsed TimeRange or null if the value doesn't contain "..".
 */
function tryParseRange(value: string): AbsoluteTimeRange | null {
  const dotDotIdx = value.indexOf("..");
  if (dotDotIdx === -1) {
    return null;
  }

  const left = value.slice(0, dotDotIdx);
  const right = value.slice(dotDotIdx + 2);

  if (left.length === 0 && right.length === 0) {
    throw new ValidationError(
      "Empty range '..'. Provide at least one date " +
        `(e.g., '${EXAMPLE_START}..', '..${EXAMPLE_END}', '${EXAMPLE_START}..${EXAMPLE_END}').`,
      "period",
    );
  }

  const start = left.length > 0 ? parseDate(left, "start") : undefined;
  const end = right.length > 0 ? parseDate(right, "end") : undefined;

  // Validate start < end when both are present
  if (start && end) {
    const startTime = new Date(start).getTime();
    const endTime = new Date(end).getTime();
    if (startTime > endTime) {
      throw new ValidationError(
        `Start date '${left}' is after end date '${right}'. ` +
          "The start must be before the end.",
        "period",
      );
    }
  }

  return { type: "absolute", start, end };
}

/**
 * Try to parse a relative duration string (e.g., "7d", "24h").
 * Returns the parsed TimeRange or null if the value isn't a valid relative duration.
 */
function tryParseRelative(value: string): RelativeTimeRange | null {
  const parts = parseRelativeParts(value);
  if (!parts) {
    return null;
  }
  if (parts.value === 0) {
    throw new ValidationError(
      `Invalid period '${value}': duration cannot be zero.`,
      "period",
    );
  }
  return { type: "relative", period: value };
}

/**
 * Parse a --period flag value into a TimeRange.
 *
 * Accepts three syntax families:
 * 1. Comparison operators: ">2024-01-01", ">=2024-01-01", "<2024-02-01", "<=2024-02-01"
 * 2. Range syntax: "2024-01-01..2024-02-01", "2024-01-01..", "..2024-02-01"
 * 3. Relative durations: "7d", "24h", "1h", "30m", "2w"
 *
 * @throws ValidationError on invalid input
 */
export function parsePeriod(value: string): TimeRange {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError(
      "Empty period value. Use a relative duration (e.g., '7d', '24h') " +
        `or a date range (e.g., '${EXAMPLE_START}..${EXAMPLE_END}', '>=${EXAMPLE_START}').`,
      "period",
    );
  }

  return (
    tryParseOperator(trimmed) ??
    tryParseRange(trimmed) ??
    tryParseRelative(trimmed) ??
    throwInvalidPeriod(trimmed)
  );
}

/** Throw a helpful error for unrecognized period values. */
function throwInvalidPeriod(value: string): never {
  throw new ValidationError(
    `Invalid period '${value}'. Use a relative duration (e.g., '7d', '24h'), ` +
      `a date range (e.g., '${EXAMPLE_START}..${EXAMPLE_END}'), ` +
      `or a comparison operator (e.g., '>=${EXAMPLE_START}', '<${EXAMPLE_END}').`,
    "period",
  );
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

/**
 * Convert a parsed TimeRange to Sentry API query parameters.
 *
 * - Relative → `{ statsPeriod: "7d" }`
 * - Absolute → `{ start: "...", end: "..." }` (either may be omitted)
 *
 * `statsPeriod` and `start`/`end` are mutually exclusive in the Sentry API.
 */
export function timeRangeToApiParams(range: TimeRange): TimeRangeApiParams {
  if (range.type === "relative") {
    return { statsPeriod: range.period };
  }
  const params: TimeRangeApiParams = {};
  if (range.start) {
    params.start = range.start;
  }
  if (range.end) {
    params.end = range.end;
  }
  // Fill missing boundary — the Sentry API requires both start and end
  // when absolute dates are used, otherwise it returns 400.
  if (params.start && !params.end) {
    params.end = new Date().toISOString();
  } else if (params.end && !params.start) {
    const endDate = new Date(params.end);
    endDate.setUTCDate(endDate.getUTCDate() - 90);
    params.start = endDate.toISOString();
  }
  return params;
}

/**
 * Serialize a TimeRange to a stable string for use in pagination context keys.
 *
 * All absolute dates are normalized to UTC (via `.toISOString()`) to ensure
 * deterministic keys regardless of local timezone. Different user syntaxes that
 * resolve to the same boundary produce the same key.
 *
 * - Relative: `"rel:7d"`
 * - Absolute: `"abs:<utc-start>..<utc-end>"`
 * - Open-ended: `"abs:<utc-start>.."` or `"abs:..<utc-end>"`
 */
export function serializeTimeRange(range: TimeRange): string {
  if (range.type === "relative") {
    return `rel:${range.period}`;
  }
  const startUtc = range.start ? new Date(range.start).toISOString() : "";
  const endUtc = range.end ? new Date(range.end).toISOString() : "";
  return `abs:${startUtc}..${endUtc}`;
}

/**
 * Compute the total duration in seconds for a TimeRange.
 *
 * - Relative: parses "7d" → 604800
 * - Absolute with both bounds: (end - start) in seconds
 * - Open-ended: returns undefined (cannot compute)
 *
 * Used by dashboard interval computation to select optimal bucket sizes.
 */
export function timeRangeToSeconds(range: TimeRange): number | undefined {
  if (range.type === "relative") {
    return relativeToSeconds(range.period);
  }

  if (range.start && range.end) {
    return absoluteRangeToSeconds(range.start, range.end);
  }

  // Open-ended range — cannot compute duration
  return;
}

/** Parse a relative period string into seconds. */
function relativeToSeconds(period: string): number | undefined {
  const parts = parseRelativeParts(period);
  if (!parts) {
    return;
  }
  const seconds = UNIT_SECONDS[parts.unit];
  return seconds ? parts.value * seconds : undefined;
}

/** Compute seconds between two ISO-8601 datetime strings. */
function absoluteRangeToSeconds(
  start: string,
  end: string,
): number | undefined {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return;
  }
  return Math.max(0, (endMs - startMs) / 1000);
}

// ---------------------------------------------------------------------------
// Pre-parsed TimeRange constants for runtime defaults
// ---------------------------------------------------------------------------

/** Pre-parsed `{ type: "relative", period: "14d" }` for commands with 14-day default. */
export const TIME_RANGE_14D: RelativeTimeRange = {
  type: "relative",
  period: "14d",
};

/** Pre-parsed `{ type: "relative", period: "24h" }` for commands with 24-hour default. */
export const TIME_RANGE_24H: RelativeTimeRange = {
  type: "relative",
  period: "24h",
};

/** Pre-parsed `{ type: "relative", period: "30d" }` for commands with 30-day default. */
export const TIME_RANGE_30D: RelativeTimeRange = {
  type: "relative",
  period: "30d",
};

// ---------------------------------------------------------------------------
// Flag value formatting
// ---------------------------------------------------------------------------

/**
 * Format a TimeRange as a CLI-friendly `--period` flag value.
 *
 * Used in pagination hint builders and error messages where the original
 * string representation is needed. Unlike {@link serializeTimeRange} (which
 * produces `rel:7d` / `abs:...` for context keys), this returns the
 * human-readable form that the user would type.
 *
 * - Relative: `"7d"`, `"24h"`
 * - Absolute both bounds: `"2024-01-01..2024-02-01"`
 * - Absolute open-ended: `">=2024-01-01"`, `"<=2024-02-01"`
 */
export function formatTimeRangeFlag(range: TimeRange): string {
  if (range.type === "relative") {
    return range.period;
  }
  if (range.start && range.end) {
    return `${range.start}..${range.end}`;
  }
  if (range.start) {
    return `>=${range.start}`;
  }
  if (range.end) {
    return `<=${range.end}`;
  }
  return "";
}

/**
 * Append a `--period` hint to a CLI hint parts array, but only when the
 * period differs from the command's default.
 *
 * This is the standard pattern for pagination hint builders across all
 * list commands. Avoids repeating the `formatTimeRangeFlag` + comparison
 * boilerplate in every command.
 *
 * @param parts - Mutable array of CLI flag strings being built
 * @param period - The current `TimeRange` from `flags.period`
 * @param defaultPeriod - The string form of the command's default (e.g. `"7d"`)
 * @param flag - The flag name to use in the hint (default: `"--period"`)
 */
export function appendPeriodHint(
  parts: string[],
  period: TimeRange,
  defaultPeriod: string,
  flag = "--period",
): void {
  const formatted = formatTimeRangeFlag(period);
  if (formatted !== defaultPeriod) {
    parts.push(`${flag} ${formatted}`);
  }
}
