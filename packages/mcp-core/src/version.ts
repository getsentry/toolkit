export const LIB_VERSION =
  (typeof process !== "undefined" && process.env?.npm_package_version) ||
  "0.0.0";

let hostVersion: string | undefined;

/**
 * Sets the version this process reports in `serverInfo`, stdio telemetry,
 * `get_sentry_mcp_info`, and User-Agent headers. The CLI ships
 * `@sentry/mcp-server` at its own version, so it calls this at startup, like
 * the agent provider settings. Hosts that never call it report `LIB_VERSION`.
 */
export function setServerVersion(version: string | undefined): void {
  hostVersion = version;
}

/** The version this process reports to clients and upstream services. */
export function getServerVersion(): string {
  return hostVersion ?? LIB_VERSION;
}

/** User-Agent for requests to Sentry, docs, and LLM providers. */
export function getUserAgent(): string {
  return `sentry-mcp/${getServerVersion()} (https://mcp.sentry.dev)`;
}
