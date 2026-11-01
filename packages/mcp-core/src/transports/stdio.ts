/**
 * Standard I/O transport for the MCP server.
 *
 * Connects a built server to stdin/stdout so a host process (such as
 * `sentry mcp`) can serve MCP over pipes. Host-specific setup — argument
 * parsing, credentials, and SDK initialization — stays with the host.
 *
 * @example
 * ```typescript
 * import { buildServer } from "@sentry/mcp-core/server";
 * import { startStdio } from "@sentry/mcp-core/transports/stdio";
 *
 * const server = buildServer({ context });
 * const { closed } = await startStdio(server, context);
 * await closed;
 * ```
 *
 * Uses MCP SDK v2, like the Cloudflare worker. Its transport closes when the
 * client closes stdin, which is what resolves `closed`.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { startNewTrace, startSpan } from "@sentry/core";
import { LIB_VERSION } from "../version";

export type StdioServerContext = {
  sentryHost?: string;
  mcpUrl?: string;
  experimentalMode?: boolean;
};

function getStdioSpanAttributes(
  context: StdioServerContext,
): Record<string, string | boolean> {
  const attributes: Record<string, string | boolean> = {
    "app.transport": "stdio",
    "app.server.version": LIB_VERSION,
    "app.server.mode.experimental": context.experimentalMode ?? false,
    "network.transport": "pipe",
    "service.version": LIB_VERSION,
  };

  if (context.sentryHost) {
    attributes["app.upstream.host"] = context.sentryHost;
  }
  if (context.mcpUrl) {
    attributes["app.url.full"] = context.mcpUrl;
  }

  return attributes;
}

/** A connected stdio server. */
export type StdioConnection = {
  /** Resolves when the transport closes, e.g. after the client closes stdin. */
  closed: Promise<void>;
};

/**
 * Connect the server to stdio inside a `mcp.server/stdio` span.
 *
 * Context is already captured in tool handler closures by `buildServer()`;
 * it is only read here for telemetry attributes.
 */
export async function startStdio<Context extends StdioServerContext>(
  server: McpServer,
  context: Context,
): Promise<StdioConnection> {
  const transport = new StdioServerTransport();
  await startNewTrace(async () => {
    return await startSpan(
      {
        name: "mcp.server/stdio",
        attributes: getStdioSpanAttributes(context),
      },
      async () => {
        await server.connect(transport);
      },
    );
  });
  // `connect()` installs the server's own close handler; chain onto it.
  const closed = new Promise<void>((resolve) => {
    const onServerClose = transport.onclose;
    transport.onclose = () => {
      onServerClose?.();
      resolve();
    };
  });
  return { closed };
}
