/**
 * Assemble an API URL from a product-validated base and a relative endpoint.
 * This does not decide which host is trusted or which region an org uses.
 */
export function buildSentryApiUrl(baseUrl: string, endpoint: string): string {
  const path = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  let end = baseUrl.length;
  while (end > 0 && baseUrl.charAt(end - 1) === "/") {
    end -= 1;
  }
  return `${baseUrl.slice(0, end)}/api/0/${path}`;
}
