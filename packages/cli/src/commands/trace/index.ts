/**
 * sentry trace
 *
 * View and explore distributed traces from Sentry projects.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";
import { logsCommand } from "./logs.js";
import { viewCommand } from "./view.js";

export const traceRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
    logs: logsCommand,
  },
  defaultCommand: "view",
  docs: {
    brief: "View distributed traces",
    fullDescription:
      "View and explore distributed traces from your Sentry projects.\n\n" +
      "Commands:\n" +
      "  list     List recent traces in a project\n" +
      "  view     View details of a specific trace\n" +
      "  logs     View logs associated with a trace\n\n" +
      "Alias: `sentry traces` → `sentry trace list`",
    hideRoute: {},
  },
});
