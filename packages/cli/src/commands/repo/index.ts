import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { listCommand } from "./list.js";

export const repoRoute = buildRouteMap({
  routes: {
    list: listCommand,
  },
  docs: {
    brief: topLevelBrief("repo"),
    fullDescription:
      "List and manage repositories connected to your Sentry organizations.\n\n" +
      "Alias: `sentry repos` → `sentry repo list`",
    hideRoute: {},
  },
});
