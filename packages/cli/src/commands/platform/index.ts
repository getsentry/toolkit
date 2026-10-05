import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";

export const platformRoute = buildRouteMap({
  routes: {
    list: listCommand,
  },
  docs: {
    brief: "List valid Sentry platform identifiers",
    fullDescription:
      "List all valid Sentry platform identifiers — the full set behind " +
      "`sentry project create <name>:<platform>`.\n\n" +
      "Alias: `sentry platforms` → `sentry platform list`",
    hideRoute: {},
  },
});
