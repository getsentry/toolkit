/**
 * Run the stdio MCP server and handle setup failures.
 *
 * Shared by `sentry mcp` and the standalone `@sentry/mcp-server` bundle.
 */

import { formatError, getExitCode } from "../errors.js";
import { startMcpServer } from "../mcp.js";

/**
 * Release network resources after a finite MCP invocation, mirroring the
 * teardown `runCli` applies to every other drained command. Never call this
 * while a stdio server is running: it would close the server's dispatcher and
 * arm a force-exit on macOS.
 */
export async function releaseProcessResources(): Promise<void> {
  const [{ scheduleForceExit }, { closeGlobalDispatcher }] = await Promise.all([
    import("../force-exit.js"),
    import("../close-dispatcher.js"),
  ]);
  scheduleForceExit();
  await closeGlobalDispatcher();
}

export async function runMcpServer(args: string[]): Promise<void> {
  try {
    if (await startMcpServer(args)) {
      return;
    }
  } catch (mcpError) {
    process.stderr.write(`Error: ${formatError(mcpError)}\n`);
    process.exitCode = getExitCode(mcpError);
  }
  // Setup errors and `--help`/`--version` are terminal, unlike a running
  // stdio server.
  await releaseProcessResources();
}
