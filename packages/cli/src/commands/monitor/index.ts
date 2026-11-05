import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { listCommand } from "./list.js";
import { runCommand } from "./run.js";
import { createCommand } from "./create.js";
import { editCommand } from "./edit.js";
import { deleteCommand } from "./delete.js";
import { viewCommand } from "./view.js";
import { cronRoute } from "./cron/index.js";

export const monitorRoute = buildRouteMap({
  routes: {
    run: runCommand,
    list: listCommand,
    view: viewCommand,
    create: createCommand,
    edit: editCommand,
    delete: deleteCommand,
    cron: cronRoute,
  },
  defaultCommand: "list",
  docs: {
    brief: topLevelBrief("monitor"),
    fullDescription:
      "Manage metric monitors (native metric detectors), inspect cron monitors with `sentry monitor cron list`, and send cron check-ins with `sentry monitor run`.\n\n" +
      "Alias: `sentry monitors` → `sentry monitor list`",
  },
});
