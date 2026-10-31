/**
 * Entry point for the `@sentry/mcp-server` bundle (`sentry-mcp`).
 *
 * Runs the CLI's runner with a smaller application (`mcp-server-app.ts`), so
 * the package gets the real `mcp` and `auth` commands without the rest of
 * the CLI. Built by `packages/mcp-server/script/bundle.ts`.
 */

// Must stay the first import: later imports can load node:sqlite, whose
// warning MCP clients surface as a server error.
import "./lib/suppress-sqlite-warning.js";
import { startCli } from "./cli.js";
import { setAppIdentity } from "./lib/app-identity.js";
import { CLI_VERSION } from "./lib/constants.js";
import { getEnv } from "./lib/env.js";
import { installStreamErrorHandlers } from "./lib/stream-errors.js";

// Same as `bin.ts`: an MCP client closing its pipes is a normal disconnect,
// not a crash, including during setup before the server's own handlers exist.
installStreamErrorHandlers();

// Before anything formats a hint: they name this package, not `sentry`.
setAppIdentity({ name: "sentry-mcp", packageName: "@sentry/mcp-server" });

// The update check announces CLI releases and `sentry cli upgrade`, which do
// not apply to this package; npm installs its updates.
getEnv().SENTRY_CLI_NO_UPDATE_CHECK = "1";

// MCP clients and install checks run a bare `--version`; answer it without
// loading the application and the CLI telemetry it brings.
if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write(`${CLI_VERSION}\n`);
} else {
  startCli({ loadApp: () => import("./mcp-server-app.js") }).catch(() => {
    process.exitCode = 1;
  });
}
