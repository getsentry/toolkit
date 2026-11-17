/**
 * The `@sentry/mcp-server` application: `mcp` (the default), `auth`, `cli`
 * (`defaults` and `fix` only), and `help`.
 *
 * Same commands as the CLI's, so `npx @sentry/mcp-server` starts the server,
 * `npx @sentry/mcp-server auth login|logout|status|list|switch` manages the
 * session it shares with the CLI, and `cli defaults|fix` manage the settings
 * and database it shares with the CLI, which its hints name. The other CLI
 * commands stay out of the bundle.
 */

import { authRoute } from "./commands/auth/index.js";
import { defaultsCommand } from "./commands/cli/defaults.js";
import { fixCommand } from "./commands/cli/fix.js";
import { helpCommand } from "./commands/help.js";
import { mcpCommand } from "./commands/mcp.js";
import { buildCliApplication } from "./lib/application.js";
import { buildRouteMap } from "./lib/route-map.js";

export const routes = buildRouteMap({
  routes: {
    mcp: mcpCommand,
    auth: authRoute,
    cli: buildRouteMap({
      routes: { defaults: defaultsCommand, fix: fixCommand },
      docs: {
        brief: "Configure defaults and repair the local database",
        fullDescription:
          "Configure defaults and repair the local database that the MCP server " +
          "shares with the Sentry CLI.",
      },
    }),
    help: helpCommand,
  },
  defaultCommand: "mcp",
  docs: {
    brief: "Sentry MCP server over stdio",
    fullDescription:
      "Run the Sentry MCP server over stdio (the default command), or manage the " +
      "Sentry login and settings it shares with the Sentry CLI.",
  },
});

export const app = buildCliApplication(routes);
