import { refreshToken } from "./db/auth.js";
import { getEnv } from "./env.js";
import { HostScopeError, ValidationError } from "./errors.js";
import { getActiveTokenHost, isHostTrusted } from "./token-host.js";

type McpServerConfig = {
  sentryHost: string;
  sentryProtocol: "http" | "https";
};

function hasSentryTargetArg(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--host" ||
      arg.startsWith("--host=") ||
      arg === "--url" ||
      arg.startsWith("--url=")
  );
}

/**
 * Translate the CLI's URL setting into MCP's host/protocol flags.
 *
 * The MCP parser intentionally rejects insecure SENTRY_URL values, while the
 * CLI uses them for self-hosted defaults. Passing explicit flags preserves the
 * selected CLI host without letting SENTRY_URL override --insecure-http.
 */
export function prepareMcpServerArgs(
  args: readonly string[],
  sentryUrl = getEnv().SENTRY_URL
): string[] {
  if (!sentryUrl || hasSentryTargetArg(args)) {
    return [...args];
  }

  // biome-ignore lint/plugin: invalid URLs are passed through to the MCP parser for its normal validation error.
  try {
    const url = new URL(sentryUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return [...args, `--url=${sentryUrl}`];
    }
    return [
      ...args,
      `--host=${url.host}`,
      ...(url.protocol === "http:" ? ["--insecure-http"] : []),
    ];
  } catch {
    return [...args, `--url=${sentryUrl}`];
  }
}

/**
 * Resolve a credential for the local MCP server from the CLI's authenticated
 * session, preserving the CLI's host-scoping protections.
 */
export async function resolveCliMcpAccessToken(
  config: McpServerConfig
): Promise<string> {
  const targetUrl = `${config.sentryProtocol}://${config.sentryHost}`;
  const { token } = await refreshToken();
  const tokenHost = getActiveTokenHost();

  if (!(tokenHost && isHostTrusted(targetUrl, tokenHost))) {
    throw new HostScopeError(
      "Cannot start MCP server with the active CLI credentials",
      targetUrl,
      tokenHost
    );
  }

  return token;
}

/** Start the local stdio server without introducing a second auth flow. */
export async function startMcpServer(args: string[]): Promise<void> {
  if (args[0] === "auth") {
    throw new ValidationError(
      "Use `sentry auth` to manage credentials for `sentry mcp`."
    );
  }

  const { runMcpServer } = await import("@sentry/mcp-server");
  const { SENTRY_URL: _sentryUrl, ...mcpEnv } = getEnv();
  await runMcpServer(prepareMcpServerArgs(args), {
    environment: mcpEnv,
    packageName: "sentry mcp",
    resolveAccessToken: resolveCliMcpAccessToken,
    throwOnError: true,
  });
}
