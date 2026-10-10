import { buildRouteMap } from "../../lib/route-map.js";
import { runCommand } from "./run.js";
import { serverCommand } from "./server.js";

export const localRoute = buildRouteMap({
  routes: {
    serve: serverCommand,
    run: runCommand,
  },
  defaultCommand: "serve",
  docs: {
    brief: "Sentry for local development",
    fullDescription:
      "Run a local development server to capture Sentry SDK events\n" +
      "from your dev stack.\n\n" +
      "Commands:\n" +
      "  serve      Start the server and tail events (default)\n" +
      "  run        Run a command with SENTRY_SPOTLIGHT auto-injected",
  },
});
