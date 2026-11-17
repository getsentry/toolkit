/** Browser-safe timestamp parsing shared by the Local tail and viewer. */

/** Fractional seconds of an ISO 8601 time, such as `.425134` in `06.425134Z`. */
const ISO_FRACTION_RE = /T\d{2}:\d{2}:\d{2}(\.\d+)/;

/**
 * Parse a Sentry event or span timestamp into epoch seconds.
 *
 * JavaScript SDKs send epoch seconds; sentry-python sends ISO 8601 strings
 * with microseconds. `Date.parse` keeps only milliseconds, so the fraction is
 * read from the string to keep sub-millisecond span durations.
 *
 * Returns undefined for anything that is not a finite number, a numeric
 * string, or a parseable date string.
 */
export function parseEventTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    return;
  }
  const fraction = ISO_FRACTION_RE.exec(value)?.[1];
  return fraction === undefined
    ? milliseconds / 1000
    : Math.floor(milliseconds / 1000) + Number(fraction);
}
