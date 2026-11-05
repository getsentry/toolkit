import { buildRouteMap } from "../../../lib/route-map.js";
import { listCommand } from "./list.js";

export const cronRoute = buildRouteMap({
  routes: { list: listCommand },
  defaultCommand: "list",
  docs: {
    brief: "Inspect cron monitors",
    fullDescription:
      "List configured cron monitors. Use sentry monitor run for command check-ins.",
  },
});
