import { buildRouteMap } from "../../../lib/route-map.js";
import { createCommand } from "./create.js";
import { deleteCommand } from "./delete.js";
import { editCommand } from "./edit.js";
import { listCommand } from "./list.js";
import { viewCommand } from "./view.js";

export const issuesRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
    create: createCommand,
    delete: deleteCommand,
    edit: editCommand,
  },
  docs: {
    brief: "Manage issue alert rules",
    fullDescription:
      "View and manage issue alert rules in your Sentry projects.\n\n" +
      "Commands:\n" +
      "  list    List issue alert rules\n" +
      "  view    View issue alert rule details\n" +
      "  create  Create an issue alert rule\n" +
      "  delete  Delete an issue alert rule\n" +
      "  edit    Update an issue alert rule",
    hideRoute: {},
  },
});
