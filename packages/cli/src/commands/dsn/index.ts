/** Project client key commands. */

import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";

export const dsnRoute = buildRouteMap({
  routes: { list: listCommand },
  docs: {
    brief: "Find Sentry DSNs",
    fullDescription:
      "List the client keys (DSNs) for a Sentry project or organization.",
    hideRoute: {},
  },
});
