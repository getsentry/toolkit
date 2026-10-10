import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";
import { viewCommand } from "./view.js";

export const orgRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
  },
  defaultCommand: "view",
  docs: {
    brief: "Work with Sentry organizations",
    fullDescription:
      "List and manage Sentry organizations you have access to.\n\n" +
      "Alias: `sentry orgs` → `sentry org list`",
    hideRoute: {},
  },
});
