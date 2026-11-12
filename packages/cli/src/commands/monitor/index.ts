import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { listCommand } from "./list.js";
import { runCommand } from "./run.js";

export const monitorRoute = buildRouteMap({
  routes: {
    run: runCommand,
    list: listCommand,
  },
  defaultCommand: "list",
  docs: {
    brief: topLevelBrief("monitor"),
    fullDescription:
      "Run commands with cron monitor check-ins and list configured monitors.\n\n" +
      "Alias: `sentry monitors` → `sentry monitor list`",
  },
});
