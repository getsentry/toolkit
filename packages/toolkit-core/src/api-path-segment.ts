/**
 * Encode one Sentry API path identifier without letting it become a URL path.
 *
 * URL parsing collapses bare `.` and `..` segments even after
 * `encodeURIComponent`, so callers must reject those identifiers before
 * constructing a request. The caller owns its product-specific error type.
 * A pre-encoded spelling such as `%2e%2e` is safe: encoding its percent signs
 * prevents the URL parser from treating it as a dot segment.
 */
export function encodeApiPathSegment(value: string | number): string | null {
  const text = String(value);
  return text === "." || text === ".." ? null : encodeURIComponent(text);
}
