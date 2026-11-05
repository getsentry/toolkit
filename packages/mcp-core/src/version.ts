export const LIB_VERSION =
  (typeof process !== "undefined" && process.env?.npm_package_version) ||
  "0.0.0";

/** The version a server built from `context` reports to clients. */
export function getServerVersion(context: { serverVersion?: string }): string {
  return context.serverVersion ?? LIB_VERSION;
}

export const USER_AGENT = `sentry-mcp/${LIB_VERSION} (https://mcp.sentry.dev)`;
