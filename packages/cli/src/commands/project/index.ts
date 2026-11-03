import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { createCommand } from "./create.js";
import { deleteCommand } from "./delete.js";
import { listCommand } from "./list.js";
import { viewCommand } from "./view.js";

export const projectRoute = buildRouteMap({
  routes: {
    create: createCommand,
    delete: deleteCommand,
    list: listCommand,
    view: viewCommand,
  },
  defaultCommand: "view",
  docs: {
    brief: topLevelBrief("project"),
    fullDescription:
      "List and manage Sentry projects in your organizations.\n\n" +
      "Alias: `sentry projects` → `sentry project list`",
    hideRoute: {},
  },
});
