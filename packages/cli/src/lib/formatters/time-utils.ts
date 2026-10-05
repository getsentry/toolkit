/**
 * Time and duration utility functions for formatters.
 *
 * Extracted to break the circular import between `human.ts` and `trace.ts`:
 * both modules need these utilities but neither should depend on the other.
 *
 * Also provides generic compact/verbose duration formatters (seconds-based)
 * used by replay commands and any future duration display.
 */

import type { TraceSpan } from "../../types/index.js";
import { colorTag } from "./markdown.js";

/**
 * Format a date string as a relative time label.
 *
 * - Under 60 minutes: "5m ago"
 * - Under 24 hours: "3h ago"
 * - Under 3 days: "2d ago"
 * - Otherwise: short date like "Jan 18"
 *
 * Returns a muted "—" when the input is undefined.
 *
 * @param dateString - ISO date string or undefined
 * @returns Human-readable relative time string
 */
export function formatRelativeTime(dateString: string | undefined): string {
  if (!dateString) {
    return colorTag("muted", "—");
  }

  const date = new Date(dateString);
  const now = Date.now();
  // Clamp to >= 0 so clock skew, scheduled/future timestamps, or bad API data
  // render as "0m ago" instead of a negative duration like "-5m ago".
  const diffMs = Math.max(0, now - date.getTime());
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  let text: string;
  if (diffMins < 60) {
    text = `${diffMins}m ago`;
  } else if (diffHours < 24) {
    text = `${diffHours}h ago`;
  } else if (diffDays < 3) {
    text = `${diffDays}d ago`;
  } else {
    // Short date: "Jan 18"
    text = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  return text;
}

// ---------------------------------------------------------------------------
// Generic duration formatting (seconds-based)
// ---------------------------------------------------------------------------

/**
 * Split a duration in seconds into days, hours, minutes, and seconds.
 * Rounds to the nearest second and clamps to non-negative.
 */
function splitDuration(totalSeconds: number): {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const rounded = Math.max(0, Math.round(totalSeconds));
  return {
    days: Math.floor(rounded / 86_400),
    hours: Math.floor((rounded % 86_400) / 3600),
    minutes: Math.floor((rounded % 3600) / 60),
    seconds: rounded % 60,
  };
}

/**
 * Pluralize a value with its singular unit name.
 *
 * @example pluralize(1, "minute") → "1 minute"
 * @example pluralize(3, "hour") → "3 hours"
 */
function pluralize(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

/**
 * Format a duration (in seconds) as a compact string for table/list output.
 *
 * Shows at most two adjacent units: `2m 5s`, `1h 1m`, `1d 1h`.
 * Returns `"—"` when the input is null or undefined.
 *
 * @param seconds - Duration in seconds, or null/undefined
 * @returns Compact duration string (e.g., `"2m 5s"`, `"1d"`, `"—"`)
 */
export function formatDurationCompact(
  seconds: number | null | undefined
): string {
  if (seconds === null || seconds === undefined) {
    return "—";
  }

  const parts = splitDuration(seconds);
  if (parts.days > 0) {
    return parts.hours > 0
      ? `${parts.days}d ${parts.hours}h`
      : `${parts.days}d`;
  }
  if (parts.hours > 0) {
    return parts.minutes > 0
      ? `${parts.hours}h ${parts.minutes}m`
      : `${parts.hours}h`;
  }
  if (parts.minutes > 0) {
    return parts.seconds > 0
      ? `${parts.minutes}m ${parts.seconds}s`
      : `${parts.minutes}m`;
  }
  return `${parts.seconds}s`;
}

/**
 * Format a duration (in milliseconds) as a compact string.
 *
 * Converts ms → seconds and delegates to {@link formatDurationCompact}.
 * Useful for activity offsets and other ms-based durations.
 *
 * @param milliseconds - Duration in milliseconds
 * @returns Compact duration string (e.g., `"2m 5s"`, `"1h"`)
 */
export function formatDurationCompactMs(milliseconds: number): string {
  return formatDurationCompact(milliseconds / 1000);
}

/**
 * Format a duration (in seconds) as a verbose human-readable string.
 *
 * Uses full unit names with "and" joining the two most significant units:
 * `"2 minutes and 5 seconds"`, `"1 hour and 1 minute"`, `"1 day"`.
 *
 * @param seconds - Duration in seconds
 * @returns Verbose duration string
 */
export function formatDurationVerbose(seconds: number): string {
  const parts = splitDuration(seconds);
  if (parts.days > 0) {
    return parts.hours > 0
      ? `${pluralize(parts.days, "day")} and ${pluralize(parts.hours, "hour")}`
      : pluralize(parts.days, "day");
  }
  if (parts.hours > 0) {
    return parts.minutes > 0
      ? `${pluralize(parts.hours, "hour")} and ${pluralize(parts.minutes, "minute")}`
      : pluralize(parts.hours, "hour");
  }
  if (parts.minutes > 0) {
    return parts.seconds > 0
      ? `${pluralize(parts.minutes, "minute")} and ${pluralize(parts.seconds, "second")}`
      : pluralize(parts.minutes, "minute");
  }
  return pluralize(parts.seconds, "second");
}

// ---------------------------------------------------------------------------
// Span duration
// ---------------------------------------------------------------------------

/**
 * Compute the duration of a span in milliseconds.
 * Prefers the API-provided `duration` field, falls back to timestamp arithmetic.
 *
 * @returns Duration in milliseconds, or undefined if not computable
 */
export function computeSpanDurationMs(span: TraceSpan): number | undefined {
  if (span.duration !== undefined && Number.isFinite(span.duration)) {
    return span.duration;
  }
  const endTs = span.end_timestamp || span.timestamp;
  if (endTs !== undefined && Number.isFinite(endTs)) {
    const ms = (endTs - span.start_timestamp) * 1000;
    return ms >= 0 ? ms : undefined;
  }
  return;
}
