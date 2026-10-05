/**
 * sentry replay
 *
 * Search, inspect, and download Session Replays.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { downloadCommand } from "./download.js";
import { listCommand } from "./list.js";
import { viewCommand } from "./view.js";

export const replayRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
    download: downloadCommand,
  },
  defaultCommand: "view",
  docs: {
    brief: "Search and inspect Session Replays",
    fullDescription:
      "Search and inspect Session Replays from your Sentry organization.\n\n" +
      "Commands:\n" +
      "  list     List recent replays in an org or project\n" +
      "  view     View details of a specific replay\n" +
      "  download Download a replay recording as rrweb JSON\n\n" +
      "Alias: `sentry replays` → `sentry replay list`",
    hideRoute: {},
  },
});
