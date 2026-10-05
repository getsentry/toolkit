import { refreshToken } from "./db/auth.js";
import { HostScopeError, ValidationError } from "./errors.js";
import { getActiveTokenHost, isHostTrusted } from "./token-host.js";

type McpServerConfig = {
  sentryHost: string;
  sentryProtocol: "http" | "https";
};

/**
 * Resolve a credential for the local MCP server from the CLI's authenticated
 * session, preserving the CLI's host-scoping protections.
 */
export async function resolveCliMcpAccessToken(
  config: McpServerConfig,
): Promise<string> {
  const targetUrl = `${config.sentryProtocol}://${config.sentryHost}`;
  const { token } = await refreshToken();
  const tokenHost = getActiveTokenHost();

  if (!tokenHost || !isHostTrusted(targetUrl, tokenHost)) {
    throw new HostScopeError(
      "Cannot start MCP server with the active CLI credentials",
      targetUrl,
      tokenHost,
    );
  }

  return token;
}

/** Start the local stdio server without introducing a second auth flow. */
export async function startMcpServer(args: string[]): Promise<void> {
  if (args[0] === "auth") {
    throw new ValidationError(
      "Use `sentry auth` to manage credentials for `sentry mcp`.",
    );
  }

  const { runMcpServer } = await import("@sentry/mcp-server");
  await runMcpServer(args, {
    packageName: "sentry mcp",
    resolveAccessToken: resolveCliMcpAccessToken,
    throwOnError: true,
  });
}
