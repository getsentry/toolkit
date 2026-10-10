import { buildRouteMap } from "../../lib/route-map.js";
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
    brief: "Work with Sentry projects",
    fullDescription:
      "List and manage Sentry projects in your organizations.\n\n" +
      "Alias: `sentry projects` → `sentry project list`",
    hideRoute: {},
  },
});
