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
 * await startStdio(server, context);
 * ```
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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

/**
 * Connect the server to stdio inside a `mcp.server/stdio` span.
 *
 * Context is already captured in tool handler closures by `buildServer()`;
 * it is only read here for telemetry attributes.
 */
export async function startStdio<Context extends StdioServerContext>(
  server: McpServer,
  context: Context,
) {
  await startNewTrace(async () => {
    return await startSpan(
      {
        name: "mcp.server/stdio",
        attributes: getStdioSpanAttributes(context),
      },
      async () => {
        const transport = new StdioServerTransport();
        await server.connect(transport);
      },
    );
  });
}
