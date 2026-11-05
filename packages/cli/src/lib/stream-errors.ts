/**
 * Stream error handlers for process entry points (`bin.ts`, `mcp-server.ts`).
 *
 * The library uses captured Writers without real streams, so it never
 * installs these.
 */

// Handle non-recoverable stream I/O errors gracefully instead of crashing.
// - EPIPE (errno -32): downstream pipe consumer closed (e.g., `sentry issue list | head`,
//   or an MCP client closing its pipes). Normal Unix behavior — not an error.
//   Exit with `process.exitCode`: 0 unless a failure was already recorded,
//   such as a fatal MCP error whose report hit the closed stderr.
// - EIO (errno -5): low-level I/O failure on the stream fd.
//   Non-recoverable — exit 1 so callers know the output was lost.
function handleStreamError(err: NodeJS.ErrnoException): void {
  if (err.code === "EPIPE") {
    // oxlint-disable-next-line sentry-cli/no-process-exit -- the pipe reader is gone (EPIPE), so nothing more can be written.
    process.exit();
  }
  if (err.code === "EIO") {
    // oxlint-disable-next-line sentry-cli/no-process-exit -- EIO lost the output; exit 1 so callers know.
    process.exit(1);
  }
  throw err;
}

/** Register {@link handleStreamError} on stdout and stderr. */
export function installStreamErrorHandlers(): void {
  process.stdout.on("error", handleStreamError);
  process.stderr.on("error", handleStreamError);
}
