import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { listCommand } from "./list.js";

export const teamRoute = buildRouteMap({
  routes: {
    list: listCommand,
  },
  docs: {
    brief: topLevelBrief("team"),
    fullDescription:
      "List and manage teams in your Sentry organizations.\n\n" +
      "Alias: `sentry teams` → `sentry team list`",
    hideRoute: {},
  },
});
