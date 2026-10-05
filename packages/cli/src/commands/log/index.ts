/**
 * sentry log
 *
 * View and stream logs from Sentry projects.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";
import { viewCommand } from "./view.js";

export const logRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
  },
  defaultCommand: "view",
  docs: {
    brief: "View Sentry logs",
    fullDescription:
      "View and stream logs from your Sentry projects.\n\n" +
      "Commands:\n" +
      "  list     List or stream logs from a project\n" +
      "  view     View details of a specific log entry\n\n" +
      "Alias: `sentry logs` → `sentry log list`",
    hideRoute: {},
  },
});
