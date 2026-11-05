import { buildRouteMap } from "../../../lib/route-map.js";
import { createCommand } from "./create.js";
import { deleteCommand } from "./delete.js";
import { editCommand } from "./edit.js";
import { listCommand } from "./list.js";
import { viewCommand } from "./view.js";

export const metricRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
    create: createCommand,
    edit: editCommand,
    delete: deleteCommand,
  },
  defaultCommand: "list",
  docs: {
    brief: "Manage metric monitors",
    fullDescription:
      "List, inspect, create, edit, and delete metric monitors (native metric detectors).",
  },
});
