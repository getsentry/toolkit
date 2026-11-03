/**
 * The `@sentry/mcp-server` application: `mcp` (the default), `auth`, and
 * `help`.
 *
 * Same commands as the CLI's, so `npx @sentry/mcp-server` starts the server
 * and `npx @sentry/mcp-server auth login|logout|status|list|switch` manages
 * the session it shares with the CLI. The other CLI commands stay out of the
 * bundle.
 */

import { authRoute } from "./commands/auth/index.js";
import { helpCommand } from "./commands/help.js";
import { mcpCommand } from "./commands/mcp.js";
import { buildCliApplication } from "./lib/application.js";
import { buildRouteMap } from "./lib/route-map.js";

export const routes = buildRouteMap({
  routes: {
    mcp: mcpCommand,
    auth: authRoute,
    help: helpCommand,
  },
  defaultCommand: "mcp",
  docs: {
    brief: "Sentry MCP server over stdio",
    fullDescription:
      "Run the Sentry MCP server over stdio (the default command), or manage the " +
      "Sentry login it shares with the Sentry CLI.",
  },
});

export const app = buildCliApplication(routes);
