/**
 * Entry point for the standalone `@sentry/mcp-server` bundle.
 *
 * Runs the same server as `sentry mcp` without the rest of the CLI, so the
 * package stays small. Built by `script/bundle-mcp-server.ts`.
 */

// Must stay the first import: later imports can load node:sqlite, whose
// warning MCP clients surface as a server error.
import "./lib/suppress-sqlite-warning.js";
import { redactCredentialText } from "./lib/credential-redaction.js";
import { CliError, formatError, getExitCode } from "./lib/errors.js";
import { preloadProjectContext } from "./lib/project-context.js";
import { installStreamErrorHandlers } from "./lib/stream-errors.js";

// Same as `bin.ts`: an MCP client closing its pipes is a normal disconnect,
// not a crash, including during setup before the server's own handlers exist.
installStreamErrorHandlers();

async function main(args: string[]): Promise<void> {
  try {
    await preloadProjectContext(process.cwd());
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`${formatError(err)}\n`);
      process.exitCode = err.exitCode;
      return;
    }
    // Project context is optional; a missing or unreadable rc file is fine.
  }

  if (args[0] === "auth") {
    const [{ runMcpServerAuth }, { releaseProcessResources }] =
      await Promise.all([
        import("./lib/mcp/auth.js"),
        import("./lib/mcp/run.js"),
      ]);
    try {
      await runMcpServerAuth(args.slice(1));
    } catch (err) {
      process.stderr.write(`Error: ${formatError(err)}\n`);
      process.exitCode = getExitCode(err);
    } finally {
      await releaseProcessResources();
    }
    return;
  }

  const { runMcpServer } = await import("./lib/mcp/run.js");
  await runMcpServer(args);
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`Fatal: ${redactCredentialText(String(err))}\n`);
  process.exitCode = 1;
});
