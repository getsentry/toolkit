import { buildRouteMap } from "../../../lib/route-map.js";
import { listCommand } from "./list.js";
import { runCommand } from "./run.js";

export const cronRoute = buildRouteMap({
  routes: { list: listCommand, run: runCommand },
  defaultCommand: "list",
  docs: {
    brief: "Manage cron monitors",
    fullDescription:
      "List configured cron monitors and send command check-ins with sentry monitor cron run.",
  },
});
