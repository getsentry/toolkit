import type { SentryContext } from "../context.js";
import { buildCommand } from "../lib/command.js";
import { CommandOutput } from "../lib/formatters/output.js";

/** Documentation route for the stdio handoff in {@link runCli}. */
export const mcpCommand = buildCommand({
  auth: false,
  docs: {
    brief: "Start a local Sentry MCP server",
    fullDescription:
      "Start the local stdio MCP server using the current Sentry CLI session. " +
      "Configure an MCP client with `sentry mcp`; authenticate first with `sentry auth login`.",
  },
  output: { human: (message: string) => message },
  parameters: {},
  // biome-ignore lint/suspicious/useAwait: async generator required by buildCommand
  async *func(this: SentryContext) {
    yield new CommandOutput(
      "The local MCP server is started by running `sentry mcp` from an MCP client configuration.",
    );
  },
});
