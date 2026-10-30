// Shared types for MCP client

export interface MCPConnection {
  client: any; // TODO: Replace with proper type from experimental MCP client
  tools: Map<string, any>;
  disconnect: () => Promise<void>;
  sessionId: string;
  transport: "stdio" | "http";
}

export type RequestedTransportMode = "auto" | "stdio" | "http";

export interface MCPConfig {
  accessToken?: string;
  host?: string;
  sentryDsn?: string;
  useExperimental?: boolean;
  /** Run the built `@sentry/mcp-server` bundle instead of CLI source. */
  useBundle?: boolean;
}

export interface RemoteMCPConfig {
  mcpHost?: string;
  accessToken?: string;
  useExperimental?: boolean;
}
