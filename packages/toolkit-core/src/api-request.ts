/**
 * Assemble an API URL from a product-validated base and a relative endpoint.
 * This does not decide which host is trusted or which region an org uses.
 */
export function buildSentryApiUrl(baseUrl: string, endpoint: string): string {
  const path = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  return `${baseUrl.replace(/\/+$/, "")}/api/0/${path}`;
}
