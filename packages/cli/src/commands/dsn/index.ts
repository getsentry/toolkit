/** Project client key commands. */

import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { listCommand } from "./list.js";

export const dsnRoute = buildRouteMap({
  routes: { list: listCommand },
  docs: {
    brief: topLevelBrief("dsn"),
    fullDescription:
      "List the client keys (DSNs) for a Sentry project or organization.",
    hideRoute: {},
  },
});
