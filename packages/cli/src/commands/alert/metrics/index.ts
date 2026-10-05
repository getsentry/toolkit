import { buildRouteMap } from "../../../lib/route-map.js";
import { createCommand } from "./create.js";
import { deleteCommand } from "./delete.js";
import { editCommand } from "./edit.js";
import { listCommand } from "./list.js";
import { viewCommand } from "./view.js";

export const metricsRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
    create: createCommand,
    delete: deleteCommand,
    edit: editCommand,
  },
  docs: {
    brief: "Manage metric alert rules",
    fullDescription:
      "View and manage metric alert rules in your Sentry organization.\n\n" +
      "Commands:\n" +
      "  list    List metric alert rules\n" +
      "  view    View metric alert rule details\n" +
      "  create  Create a metric alert rule\n" +
      "  delete  Delete a metric alert rule\n" +
      "  edit    Update a metric alert rule",
    hideRoute: {},
  },
});
