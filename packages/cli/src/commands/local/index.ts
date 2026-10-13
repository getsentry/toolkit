import { buildRouteMap } from "../../lib/route-map.js";
import {
  daemonRoute,
  envelopeRoute,
  eventRoute,
  sessionRoute,
} from "./management.js";
import { runCommand } from "./run.js";
import { serverCommand } from "./server.js";

export const localRoute = buildRouteMap({
  routes: {
    daemon: daemonRoute,
    envelope: envelopeRoute,
    event: eventRoute,
    serve: serverCommand,
    session: sessionRoute,
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
      "  run        Run a command with SENTRY_SPOTLIGHT auto-injected\n" +
      "  daemon     Manage the shared telemetry daemon\n" +
      "  session    Create, inspect, reset, and close sessions\n" +
      "  event      Query decoded session events\n" +
      "  envelope   Query raw session envelopes",
  },
});
