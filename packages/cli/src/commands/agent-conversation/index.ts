/**
 * sentry agent-conversation
 *
 * List and view agent conversations from Sentry Explore.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";
import { viewCommand } from "./view.js";

export const conversationRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
  },
  defaultCommand: "list",
  docs: {
    brief: "List and view agent conversations",
    fullDescription:
      "List and view agent conversations from Sentry Explore.\n\n" +
      "Commands:\n" +
      "  list     List recent agent conversations\n" +
      "  view     View a conversation transcript\n",
    hideRoute: {},
  },
});
