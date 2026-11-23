/**
 * sentry log
 *
 * List, stream, and view logs from Sentry projects.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { listCommand } from "./list.js";
import { tailCommand } from "./tail.js";
import { viewCommand } from "./view.js";

export const logRoute = buildRouteMap({
  routes: {
    list: listCommand,
    tail: tailCommand,
    view: viewCommand,
  },
  defaultCommand: "view",
  docs: {
    brief: topLevelBrief("log"),
    fullDescription:
      "List, stream, and view logs from your Sentry projects.\n\n" +
      "Commands:\n" +
      "  list     List logs from a project\n" +
      "  tail     Stream new logs from a project or trace\n" +
      "  view     View details of a specific log entry\n\n" +
      "Alias: `sentry logs` → `sentry log list`",
    hideRoute: {},
  },
});
