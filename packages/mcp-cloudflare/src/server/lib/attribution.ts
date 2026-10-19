// Server-side attribution helpers. These live separately from client-side
// attribution (client/utils/attribution.ts) because the two contexts have
// different known utm_source values and different APIs (no window/document
// on the server).

/**
 * Span/metric attribute name for the bucketed utm_source value.
 * Use this constant in all call sites to avoid drift.
 */
export const UTM_SOURCE_ATTRIBUTE = "app.utm_source";

/**
 * HTTP header used by MCP clients (e.g. the Claude plugin) to pass attribution
 * without folding it into the OAuth resource URL / RFC 8707 resource indicator.
 *
 * Prefer this over `?utm_source=` when the client supports custom headers.
 */
export const UTM_SOURCE_HEADER = "X-Sentry-Utm-Source";

/**
 * Buckets a raw utm_source value into a fixed allow-list so it is safe to use
 * as a metric/span attribute (raw values are unbounded cardinality). Returns
 * null when the value is absent so callers can skip setting the attribute
 * entirely — absence means "no UTM source", which is different from "unknown
 * UTM source".
 *
 * Known server-side values:
 *   "plugin" — MCP traffic tagged by a sentry-for-ai AI plugin
 */
export function resolveUtmSource(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  switch (raw) {
    case "plugin":
      return raw;
    default:
      return "other";
  }
}

/**
 * Convenience wrapper that reads utm_source from URL search params.
 */
export function resolveUtmSourceFromUrl(url: URL): string | null {
  return resolveUtmSource(url.searchParams.get("utm_source"));
}

/**
 * Resolve utm_source for an MCP request.
 *
 * Prefer the dedicated attribution header so clients can keep the MCP resource
 * URL free of query params (important for OAuth resource indicators). Fall back
 * to `?utm_source=` for existing plugin configs that still tag the URL.
 */
export function resolveUtmSourceFromRequest(
  request: Request,
  url: URL = new URL(request.url),
): string | null {
  const fromHeader = resolveUtmSource(request.headers.get(UTM_SOURCE_HEADER));
  if (fromHeader) {
    return fromHeader;
  }
  return resolveUtmSourceFromUrl(url);
}

/** Headers sent by sentry-for-ai plugins to identify the distribution and release. */
export const PLUGIN_NAME_HEADER = "X-Sentry-Plugin";
export const PLUGIN_VERSION_HEADER = "X-Sentry-Plugin-Version";

export const PLUGIN_NAME_ATTRIBUTE = "app.plugin.name";
export const PLUGIN_VERSION_ATTRIBUTE = "app.plugin.version";

const KNOWN_PLUGIN_NAMES = new Set([
  "claude",
  "cursor",
  "codex",
  "copilot",
  "grok",
  "agent-plugin",
]);

/**
 * Buckets the plugin distribution name. Returns null when absent.
 */
export function resolvePluginName(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  return KNOWN_PLUGIN_NAMES.has(raw) ? raw : "other";
}

/**
 * Keeps release versions (`1.4.5`), buckets prerelease builds
 * (`1.4.6-dev.14.gdeadbee`) to "dev" and anything else to "other".
 * Returns null when absent.
 */
export function resolvePluginVersion(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  if (/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(raw)) return raw;
  if (/^\d+\.\d+\.\d+-/.test(raw)) return "dev";
  return "other";
}

/**
 * Resolve plugin attribution attributes for a request, omitting absent ones.
 */
export function resolvePluginAttributesFromRequest(
  request: Request,
): Record<string, string> {
  const attributes: Record<string, string> = {};
  const name = resolvePluginName(request.headers.get(PLUGIN_NAME_HEADER));
  if (name) {
    attributes[PLUGIN_NAME_ATTRIBUTE] = name;
  }
  const version = resolvePluginVersion(
    request.headers.get(PLUGIN_VERSION_HEADER),
  );
  if (version) {
    attributes[PLUGIN_VERSION_ATTRIBUTE] = version;
  }
  return attributes;
}
