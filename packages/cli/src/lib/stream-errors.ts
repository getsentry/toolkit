/**
 * Stream error handlers for process entry points (`bin.ts`, `mcp-server.ts`).
 *
 * The library uses captured Writers without real streams, so it never
 * installs these.
 */

// Handle non-recoverable stream I/O errors gracefully instead of crashing.
// - EPIPE (errno -32): downstream pipe consumer closed (e.g., `sentry issue list | head`,
//   or an MCP client closing its pipes). Normal Unix behavior — not an error.
//   Exit 0 because the process succeeded.
// - EIO (errno -5): low-level I/O failure on the stream fd.
//   Non-recoverable — exit 1 so callers know the output was lost.
function handleStreamError(err: NodeJS.ErrnoException): void {
  if (err.code === "EPIPE") {
    process.exit(0);
  }
  if (err.code === "EIO") {
    process.exit(1);
  }
  throw err;
}

/** Register {@link handleStreamError} on stdout and stderr. */
export function installStreamErrorHandlers(): void {
  process.stdout.on("error", handleStreamError);
  process.stderr.on("error", handleStreamError);
}
