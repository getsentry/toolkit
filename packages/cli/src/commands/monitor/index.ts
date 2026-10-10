import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";
import { runCommand } from "./run.js";

export const monitorRoute = buildRouteMap({
  routes: {
    run: runCommand,
    list: listCommand,
  },
  defaultCommand: "list",
  docs: {
    brief: "Work with Sentry cron monitors",
    fullDescription:
      "Run commands with cron monitor check-ins and list configured monitors.\n\n" +
      "  sentry monitor run <slug> -- <command>  # wrap a command with check-ins\n" +
      "  sentry monitor list                     # list configured monitors\n\n" +
      "Alias: `sentry monitors` → `sentry monitor list`",
  },
});
