/** Browser-safe timestamp parsing shared by the Local tail and viewer. */

/** A plain decimal number of seconds, such as `1700000000.5`. */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** An ISO 8601 date at the start of a string, such as `2026-11-17`. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** Fractional seconds of an ISO 8601 time, such as `.425134` in `06.425134Z`. */
const ISO_FRACTION_RE = /[T ]\d{2}:\d{2}:\d{2}(\.\d+)/;

/** An ISO 8601 date and time that ends without `Z` or a UTC offset. */
const ISO_NAIVE_TIME_RE = /[T ]\d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * Parse a Sentry event or span timestamp into epoch seconds.
 *
 * JavaScript SDKs send epoch seconds; sentry-python sends ISO 8601 strings
 * with microseconds. `Date.parse` keeps only milliseconds, so the fraction is
 * read from the string to keep sub-millisecond span durations. A time with no
 * timezone is read as UTC, like Relay does, not as the host's local time.
 *
 * Returns undefined for anything that is not a finite number, a decimal
 * string, or an ISO 8601 date string. Other strings are rejected before
 * `Date.parse`, which reads loose text such as `" 12 "` as a date.
 */
export function parseEventTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return;
  }
  if (DECIMAL_RE.test(value)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  if (!ISO_DATE_RE.test(value)) {
    return;
  }
  const milliseconds = Date.parse(
    ISO_NAIVE_TIME_RE.test(value) ? `${value}Z` : value,
  );
  if (Number.isNaN(milliseconds)) {
    return;
  }
  const fraction = ISO_FRACTION_RE.exec(value)?.[1];
  return fraction === undefined
    ? milliseconds / 1000
    : Math.floor(milliseconds / 1000) + Number(fraction);
}
