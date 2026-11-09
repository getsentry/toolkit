import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { listCommand } from "./list.js";

export const platformRoute = buildRouteMap({
  routes: {
    list: listCommand,
  },
  docs: {
    brief: topLevelBrief("platform"),
    fullDescription:
      "List all valid Sentry platform identifiers — the full set behind " +
      "`sentry project create <name>:<platform>`.\n\n" +
      "Alias: `sentry platforms` → `sentry platform list`",
    hideRoute: {},
  },
});
