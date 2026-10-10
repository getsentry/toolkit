/**
 * sentry span
 *
 * List and explore individual spans within distributed traces or across projects.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";
import { viewCommand } from "./view.js";

export const spanRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
  },
  defaultCommand: "view",
  docs: {
    brief: "List and view spans in projects or traces",
    fullDescription:
      "List and explore individual spans within distributed traces or across projects.\n\n" +
      "Commands:\n" +
      "  list     List spans in a project or trace\n" +
      "  view     View details of specific spans\n\n" +
      "Alias: `sentry spans` → `sentry span list`",
  },
});
