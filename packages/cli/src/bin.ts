/**
 * CLI entry point.
 *
 * Stream error handlers are registered here (not in cli.ts) because they're
 * CLI-specific — the library uses captured Writers that don't have real streams.
 */

// Must stay the first import: later imports can load node:sqlite.
import "./lib/suppress-sqlite-warning.js";
import { startCli } from "./cli.js";
import { wrapCall } from "./lib/react-native/wrap-call.js";

// React Native Xcode build wrapper: when the RN build script invokes us in
// place of NODE_BINARY/HERMES_CLI_PATH (see `react-native xcode`), forward to
// the real Node/Hermes tool instead of running the CLI. Must run before any
// command parsing.
if (process.env.__SENTRY_RN_WRAP_XCODE_CALL === "1") {
  process.exit(wrapCall());
}

// Handle non-recoverable stream I/O errors gracefully instead of crashing.
// - EPIPE (errno -32): downstream pipe consumer closed (e.g., `sentry issue list | head`).
//   Normal Unix behavior — not an error. Exit 0 because the CLI succeeded.
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

process.stdout.on("error", handleStreamError);
process.stderr.on("error", handleStreamError);

// startCli handles its own errors — this is a safety net for truly unexpected rejections
startCli().catch(() => {
  process.exitCode = 1;
});
