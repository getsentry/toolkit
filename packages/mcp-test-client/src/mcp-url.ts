import { DEFAULT_MCP_URL } from "./constants.js";

/**
 * Normalize the configured MCP value into the exact protected resource URL.
 *
 * This is the resource identifier used for RFC 9728 protected resource
 * metadata and for the RFC 8707 `resource` authorization request parameter.
 *
 * Examples:
 * - `https://mcp.sentry.dev` -> `https://mcp.sentry.dev/mcp`
 * - `https://mcp.sentry.dev/mcp/sentry` -> unchanged
 */
export function resolveProtectedResourceUrl(mcpHost?: string): URL {
  const protectedResourceUrl = new URL(mcpHost || DEFAULT_MCP_URL);

  if (
    protectedResourceUrl.pathname === "/" ||
    protectedResourceUrl.pathname === ""
  ) {
    protectedResourceUrl.pathname = "/mcp";
  }

  return protectedResourceUrl;
}

/**
 * Get the OAuth server base URL for a protected resource.
 */
export function resolveAuthorizationServerUrl(mcpHost?: string): URL {
  const protectedResourceUrl = resolveProtectedResourceUrl(mcpHost);
  return new URL(protectedResourceUrl.origin);
}

/**
 * Apply optional MCP endpoint flags to the protected resource URL.
 */
export function applyProtectedResourceFlags(
  protectedResourceUrl: URL,
  options: {
    useExperimental?: boolean | undefined;
  },
): URL {
  if (options.useExperimental) {
    protectedResourceUrl.searchParams.set("experimental", "1");
  }

  return protectedResourceUrl;
}
