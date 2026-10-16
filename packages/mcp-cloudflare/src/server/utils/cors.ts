/**
 * CORS utilities for the Cloudflare worker entry point.
 *
 * Why this exists:
 * The OAuth provider manages several routes directly (token, register, MCP API,
 * well-known metadata) and may attach permissive CORS headers to the responses
 * it handles. We can't configure that behavior in the library, so the worker
 * normalizes CORS at the edge.
 *
 * Our strategy (implemented in the wrappedOAuthProvider in index.ts):
 * 1. Intercept OPTIONS before the library runs — return our own preflight.
 * 2. Let the library handle the actual request (it will add its CORS headers).
 * 3. On the way out, either:
 *    - Replace with restrictive CORS for public metadata endpoints, or
 *    - Strip the library's CORS headers entirely for everything else.
 */

/** Paths that should be accessible from any origin (read-only metadata). */
const PUBLIC_METADATA_PATHS = [
  "/.well-known/", // OAuth/resource discovery (RFC 8414, RFC 9728)
  "/.mcp/", // MCP tool definitions for documentation sites
  "/robots.txt", // Search engine directives
  "/llms.txt", // LLM/AI agent directives
  "/mcp.json", // MCP server metadata
];

/**
 * Check whether a pathname serves public, read-only metadata that should
 * be available cross-origin. Prefix entries (ending with "/") use startsWith;
 * exact entries require an exact match.
 */
export const isPublicMetadataEndpoint = (pathname: string): boolean => {
  return PUBLIC_METADATA_PATHS.some((path) =>
    path.endsWith("/") ? pathname.startsWith(path) : pathname === path,
  );
};

/**
 * OAuth endpoints that public (browser-based) clients call directly as part
 * of the authorization-code + PKCE exchange: token exchange and dynamic
 * client registration. Both are exact matches — do not broaden to a prefix,
 * since `/oauth/authorize` and other OAuth routes must keep the restrictive
 * default.
 */
const OAUTH_PUBLIC_CLIENT_PATHS = ["/oauth/token", "/oauth/register"];

/**
 * Check whether a pathname is one of the OAuth endpoints a public,
 * browser-based client (e.g. an admin UI performing the authorization-code
 * exchange in-page, per RFC 8252 §7 / OAuth 2.1) must be able to call
 * cross-origin.
 */
export const isOAuthPublicClientEndpoint = (pathname: string): boolean => {
  return OAUTH_PUBLIC_CLIENT_PATHS.includes(pathname);
};

/**
 * Apply restrictive CORS headers suitable for public metadata endpoints.
 * Only allows GET and OPTIONS with Content-Type — no credentials, no mutation.
 * Uses `*` origin since these endpoints serve non-sensitive, publicly-available data.
 *
 * Also removes any leftover CORS headers the OAuth library may have added
 * (e.g. Max-Age, Expose-Headers, Allow-Credentials) to prevent contradictory
 * or overly permissive combinations.
 */
export const addCorsHeaders = (response: Response): Response => {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set("Access-Control-Allow-Origin", "*");
  newResponse.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  newResponse.headers.set("Access-Control-Allow-Headers", "Content-Type");
  // Remove headers the OAuth library may have set that we don't want
  newResponse.headers.delete("Access-Control-Max-Age");
  newResponse.headers.delete("Access-Control-Expose-Headers");
  newResponse.headers.delete("Access-Control-Allow-Credentials");
  return newResponse;
};

/**
 * Apply CORS headers for the OAuth token-exchange and dynamic client
 * registration endpoints, scoped to the requesting Origin.
 *
 * These endpoints are protected by PKCE (RFC 7636) rather than CORS: the
 * authorization code alone is not sufficient to obtain a token without the
 * matching `code_verifier`, so allowing cross-origin calls here does not
 * bypass an auth boundary the way it would for cookie-authenticated routes.
 * Browser-based public clients (e.g. an admin UI completing the
 * authorization-code exchange in-page, or MCP Inspector) cannot complete
 * OAuth without this — see getsentry/sentry-mcp#999.
 *
 * Reflects the specific request Origin (never `*`) so responses vary per
 * origin and cannot be cached across origins; omits
 * `Access-Control-Allow-Credentials` since these endpoints authenticate via
 * the request body/PKCE, not cookies.
 */
export const addOAuthPublicClientCorsHeaders = (
  response: Response,
  origin: string | null,
): Response => {
  const newResponse = new Response(response.body, response);
  // No Origin header means no cross-origin request is in flight (e.g. a
  // same-origin call, or a non-browser client) — strip any CORS headers the
  // library may have added rather than publishing a Methods/Headers policy
  // with no matching Allow-Origin.
  if (!origin) {
    newResponse.headers.delete("Access-Control-Allow-Origin");
    newResponse.headers.delete("Access-Control-Allow-Methods");
    newResponse.headers.delete("Access-Control-Allow-Headers");
    newResponse.headers.delete("Access-Control-Allow-Credentials");
    newResponse.headers.delete("Access-Control-Max-Age");
    newResponse.headers.delete("Access-Control-Expose-Headers");
    newResponse.headers.delete("Vary");
    return newResponse;
  }
  newResponse.headers.set("Access-Control-Allow-Origin", origin);
  newResponse.headers.set("Vary", "Origin");
  newResponse.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  newResponse.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization",
  );
  newResponse.headers.delete("Access-Control-Allow-Credentials");
  newResponse.headers.delete("Access-Control-Expose-Headers");
  return newResponse;
};

/**
 * Remove all CORS headers from a response.
 *
 * This removes any CORS headers the OAuth provider added automatically.
 * Without stripping, other OAuth/MCP endpoints (e.g. bearer-token-protected
 * `/mcp` routes) could be callable cross-origin from any website.
 *
 * Returns the original response unchanged if no CORS headers are present
 * (e.g. when the request had no Origin header so the library skipped CORS).
 */
export const stripCorsHeaders = (response: Response): Response => {
  if (!response.headers.has("Access-Control-Allow-Origin")) {
    return response;
  }
  const newResponse = new Response(response.body, response);
  newResponse.headers.delete("Access-Control-Allow-Origin");
  newResponse.headers.delete("Access-Control-Allow-Methods");
  newResponse.headers.delete("Access-Control-Allow-Headers");
  newResponse.headers.delete("Access-Control-Max-Age");
  newResponse.headers.delete("Access-Control-Expose-Headers");
  return newResponse;
};
