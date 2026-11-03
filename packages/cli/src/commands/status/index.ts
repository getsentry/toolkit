/**
 * sentry status
 *
 * Check the status of Sentry's services.
 */

import { topLevelBrief } from "../../command-manifest.js";
import { buildRouteMap } from "../../lib/route-map.js";
import { showCommand } from "./show.js";

export const statusRoute = buildRouteMap({
  routes: {
    show: showCommand,
  },
  defaultCommand: "show",
  docs: {
    brief: topLevelBrief("status"),
    fullDescription:
      "Report the current status of Sentry's services using the public " +
      "status page (https://status.sentry.io) as the backend.\n\n" +
      "Running `sentry status` with no subcommand shows the current status.",
    hideRoute: {},
  },
});
