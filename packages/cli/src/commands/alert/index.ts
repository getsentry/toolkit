import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { createCommand } from "./create.js";
import { deleteCommand } from "./delete.js";
import { editCommand } from "./edit.js";
import { listCommand } from "./list.js";
import { viewCommand } from "./view.js";

export const alertRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
    create: createCommand,
    edit: editCommand,
    delete: deleteCommand,
  },
  docs: {
    brief: topLevelBrief("alert"),
    fullDescription:
      "Manage organization alerts (native workflows), including detached alerts and alerts connected to any monitor. Use sentry monitor for metric detectors and sentry monitor cron for cron monitors.",
  },
});
