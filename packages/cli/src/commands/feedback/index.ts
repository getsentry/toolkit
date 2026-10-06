/**
 * sentry feedback
 *
 * Search, inspect, and manage modern Sentry User Feedback.
 */

import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";
import { resolveCommand } from "./resolve.js";
import { spamCommand } from "./spam.js";
import { unresolveCommand } from "./unresolve.js";
import { viewCommand } from "./view.js";

export const feedbackRoute = buildRouteMap({
  routes: {
    list: listCommand,
    view: viewCommand,
    resolve: resolveCommand,
    unresolve: unresolveCommand,
    spam: spamCommand,
  },
  aliases: { reopen: "unresolve" },
  defaultCommand: "view",
  docs: {
    brief: "Manage User Feedback",
    fullDescription:
      "Search, inspect, and manage modern User Feedback from your Sentry organization.\n\n" +
      "Commands:\n" +
      "  list       List and search feedback\n" +
      "  view       View feedback with its latest event context\n" +
      "  resolve    Mark feedback as resolved\n" +
      "  unresolve  Return feedback to the inbox (alias: reopen)\n" +
      "  spam       Mark feedback as spam",
    hideRoute: {},
  },
});
