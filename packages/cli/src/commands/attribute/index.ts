/** Trace item attribute commands. */

import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { listCommand } from "./list.js";

export const attributeRoute = buildRouteMap({
  routes: { list: listCommand },
  docs: {
    brief: topLevelBrief("attribute"),
    fullDescription:
      "List the attribute keys available on spans, logs, and trace metrics.\n\n" +
      "Commands:\n" +
      "  list     List attribute keys with their type and source\n\n" +
      "Alias: `sentry attributes` → `sentry attribute list`",
    hideRoute: {},
  },
});
