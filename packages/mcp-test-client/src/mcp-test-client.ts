import { experimental_createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startNewTrace, startSpan } from "@sentry/core";
import { logSuccess } from "./logger.js";
import type { MCPConnection, MCPConfig } from "./types.js";
import { randomUUID } from "node:crypto";
import { LIB_VERSION } from "./version.js";
import { buildStdioServerLaunchConfig } from "./transport.js";

export async function connectToMCPServer(
  config: MCPConfig,
): Promise<MCPConnection> {
  const sessionId = randomUUID();

  return await startNewTrace(async () => {
    return await startSpan(
      {
        name: "mcp.connect/stdio",
        attributes: {
          "app.transport": "stdio",
          "gen_ai.conversation.id": sessionId,
          "service.version": LIB_VERSION,
        },
      },
      async (span) => {
        try {
          // Run the workspace CLI's `sentry mcp` from source.
          const cliDir = join(
            dirname(fileURLToPath(import.meta.url)),
            "../../cli",
          );
          const launchConfig = buildStdioServerLaunchConfig(config);

          const transport = new Experimental_StdioMCPTransport({
            command: "pnpm",
            args: [
              "--silent",
              "--dir",
              cliDir,
              "run",
              "cli",
              "mcp",
              ...launchConfig.args,
            ],
            env: launchConfig.env,
          });

          const client = await experimental_createMCPClient({
            name: "mcp.sentry.dev (test-client)",
            transport,
          });

          // Discover available tools
          const toolsMap = await client.tools();
          const tools = new Map<string, any>();

          for (const [name, tool] of Object.entries(toolsMap)) {
            tools.set(name, tool);
          }

          // Remove custom attributes - let SDK handle standard attributes
          span.setStatus({ code: 1 }); // OK status

          logSuccess(
            "Connected to MCP server (stdio)",
            `${tools.size} tools available`,
          );

          const disconnect = async () => {
            await client.close();
          };

          return {
            client,
            tools,
            disconnect,
            sessionId,
            transport: "stdio" as const,
          };
        } catch (error) {
          span.setStatus({ code: 2 }); // Error status
          throw error;
        }
      },
    );
  });
}
