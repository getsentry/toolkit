/**
 * Helpers for the `input` argument of `fetch()`.
 */

/**
 * Extract the full URL string from a fetch input.
 *
 * `String(request)` yields `"[object Request]"`, so `Request` inputs need
 * their `.url` read explicitly.
 */
export function extractInputUrl(input: Request | string | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}
