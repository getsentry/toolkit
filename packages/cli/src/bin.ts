/**
 * CLI entry point.
 *
 * Stream error handlers are registered here (not in cli.ts) because they're
 * CLI-specific — the library uses captured Writers that don't have real streams.
 * See `lib/stream-errors.ts`.
 */

// Must stay the first import: later imports can load node:sqlite.
import "./lib/suppress-sqlite-warning.js";
import { startCli } from "./cli.js";
import { wrapCall } from "./lib/react-native/wrap-call.js";
import { installStreamErrorHandlers } from "./lib/stream-errors.js";

// React Native Xcode build wrapper: when the RN build script invokes us in
// place of NODE_BINARY/HERMES_CLI_PATH (see `react-native xcode`), forward to
// the real Node/Hermes tool instead of running the CLI. Must run before any
// command parsing.
if (process.env.__SENTRY_RN_WRAP_XCODE_CALL === "1") {
  process.exit(wrapCall());
}

installStreamErrorHandlers();

// startCli handles its own errors — this is a safety net for truly unexpected rejections
startCli().catch(() => {
  process.exitCode = 1;
});
