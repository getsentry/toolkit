/** Trace item attribute commands. */

import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";

export const attributeRoute = buildRouteMap({
  routes: { list: listCommand },
  docs: {
    brief: "Explore span, log, and metric attributes",
    fullDescription:
      "List the attribute keys available on spans, logs, and trace metrics.\n\n" +
      "Commands:\n" +
      "  list     List attribute keys with their type and source\n\n" +
      "Alias: `sentry attributes` → `sentry attribute list`",
    hideRoute: {},
  },
});
