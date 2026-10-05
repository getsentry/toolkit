import { buildRouteMap } from "../../lib/route-map.js";
import { createCommand } from "./create.js";
import { listCommand } from "./list.js";
import { restoreCommand } from "./restore.js";
import { revisionsCommand } from "./revisions.js";
import { viewCommand } from "./view.js";
import { widgetRoute } from "./widget/index.js";

export const dashboardRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
    create: createCommand,
    widget: widgetRoute,
    revisions: revisionsCommand,
    restore: restoreCommand,
  },
  defaultCommand: "view",
  aliases: { history: "revisions" },
  docs: {
    brief: "Manage Sentry dashboards",
    fullDescription:
      "View and manage dashboards in your Sentry organization.\n\n" +
      "Commands:\n" +
      "  list       List dashboards\n" +
      "  view       View a dashboard\n" +
      "  create     Create a dashboard\n" +
      "  widget     Manage dashboard widgets (add, edit, delete)\n" +
      "  revisions  List dashboard revision history\n" +
      "  restore    Restore a dashboard to a previous revision",
    hideRoute: {},
  },
});
