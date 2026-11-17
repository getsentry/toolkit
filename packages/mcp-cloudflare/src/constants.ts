export { SCOPES } from "@sentry/mcp-core/scopes";

/** Command that starts the local MCP server through the Sentry CLI (`sentry mcp`). */
export const CLI_MCP_COMMAND = "sentry";
export const CLI_MCP_ARGS = ["mcp"];
export const CLI_MCP_SNIPPET = [CLI_MCP_COMMAND, ...CLI_MCP_ARGS].join(" ");

export const CLI_INSTALL_COMMAND =
  "curl https://cli.sentry.dev/install -fsS | bash";
