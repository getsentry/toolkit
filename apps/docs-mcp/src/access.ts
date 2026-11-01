const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

/**
 * docs-mcp is intentionally callable only through the DOCS_MCP service binding.
 * Cloudflare preserves the request URL passed to Fetcher.fetch(), so the caller's
 * private `docs-mcp.internal` origin is available here without a shared secret.
 * Local development also accepts localhost origins.
 */
export function isDocsMcpServiceRequest(request: Request): boolean {
  const { url } = request;
  const { hostname } = new URL(url);
  return hostname === "docs-mcp.internal" || LOCAL_HOSTNAMES.has(hostname);
}
