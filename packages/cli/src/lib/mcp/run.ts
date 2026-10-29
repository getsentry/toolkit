/**
 * Run the stdio MCP server and handle setup failures.
 *
 * Shared by `sentry mcp` and the standalone `@sentry/mcp-server` bundle.
 */

import { formatError, getExitCode } from "../errors.js";
import { startMcpServer } from "../mcp.js";

export async function runMcpServer(args: string[]): Promise<void> {
  try {
    await startMcpServer(args);
  } catch (mcpError) {
    process.stderr.write(`Error: ${formatError(mcpError)}\n`);
    process.exitCode = getExitCode(mcpError);
    // MCP setup errors are terminal, unlike a running stdio server. Clean up
    // network resources only on this error path so successful servers retain
    // their dispatcher and are not force-exited on macOS.
    const [{ scheduleForceExit }, { closeGlobalDispatcher }] =
      await Promise.all([
        import("../force-exit.js"),
        import("../close-dispatcher.js"),
      ]);
    scheduleForceExit();
    await closeGlobalDispatcher();
  }
}
