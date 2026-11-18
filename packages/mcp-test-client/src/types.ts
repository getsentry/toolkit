// Shared types for MCP client

import type { MCPClient } from "@ai-sdk/mcp";

/** One tool from the MCP client's tool set. */
export type MCPTool = Awaited<ReturnType<MCPClient["tools"]>>[string];

export interface MCPConnection {
  /** The part of the MCP client the agent uses. */
  client: { tools: () => Promise<Record<string, MCPTool>> };
  tools: Map<string, MCPTool>;
  disconnect: () => Promise<void>;
  sessionId: string;
  transport: "stdio" | "http";
}

export type RequestedTransportMode = "auto" | "stdio" | "http";

export interface MCPConfig {
  accessToken?: string | undefined;
  host?: string | undefined;
  useExperimental?: boolean | undefined;
  /** Run the built `@sentry/mcp-server` bundle instead of CLI source. */
  useBundle?: boolean | undefined;
}

export interface RemoteMCPConfig {
  mcpHost?: string | undefined;
  accessToken?: string | undefined;
  useExperimental?: boolean | undefined;
}
