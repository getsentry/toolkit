/** Browser-safe HTTP target lookup shared by the Local tail and viewer. */

/**
 * Span attributes that name an HTTP request's target, best first: the route
 * template, then the full URL, then the path. Callers decide how to show the
 * value; the viewer, for example, shows only a URL's path for server spans.
 */
const HTTP_TARGET_ATTRIBUTES = [
  "http.route",
  "url.template",
  "url.full",
  "url.path",
] as const;

export type HttpTargetAttribute = (typeof HTTP_TARGET_ATTRIBUTES)[number];

/** The first target attribute, in `HTTP_TARGET_ATTRIBUTES` order, with a value. */
export function httpTargetAttribute(
  read: (key: HttpTargetAttribute) => string | undefined,
): { key: HttpTargetAttribute; value: string } | undefined {
  for (const key of HTTP_TARGET_ATTRIBUTES) {
    const value = read(key);
    if (value) return { key, value };
  }
  return undefined;
}
