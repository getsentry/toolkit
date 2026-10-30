/**
 * The sign-in commands that auth hints name. The standalone
 * `@sentry/mcp-server` bundle has its own `auth login`, so its users are not
 * sent to a CLI they may not have installed.
 */

/** Set by `packages/mcp-server/script/bundle.ts` to the `@sentry/mcp-server` version. */
declare const SENTRY_MCP_SERVER_VERSION: string | undefined;

/** The `@sentry/mcp-server` version when running as that bundle. */
export const MCP_SERVER_VERSION =
  typeof SENTRY_MCP_SERVER_VERSION === "undefined"
    ? undefined
    : SENTRY_MCP_SERVER_VERSION;

/** Command that signs in to the active Sentry host. */
export const LOGIN_COMMAND = MCP_SERVER_VERSION
  ? "npx -y @sentry/mcp-server auth login"
  : "sentry auth login";

/**
 * Command that signs in and confirms a self-hosted host. The standalone
 * `auth login` takes no `--url`, so the bundle points at the CLI, which
 * shares the session.
 */
export const URL_LOGIN_COMMAND = MCP_SERVER_VERSION
  ? "npx -y sentry auth login --url"
  : "sentry auth login --url";
