import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { analyticsCommand } from "./analytics.js";
import { listCommand } from "./list.js";
import { sendCommand } from "./send.js";
import { viewCommand } from "./view.js";

export const eventRoute = buildRouteMap({
  routes: {
    view: viewCommand,
    list: listCommand,
    send: sendCommand,
    analytics: analyticsCommand,
  },
  defaultCommand: "view",
  docs: {
    brief: topLevelBrief("event"),
    fullDescription:
      "View, list, and send event data from Sentry.\n\n" +
      "Use 'sentry event view <event-id>' to view a specific event.\n" +
      "Use 'sentry event list <issue-id>' to list events for an issue.\n" +
      "Use 'sentry event send -m <message>' to send a test event.\n" +
      "Use 'sentry event analytics' to see accepted and dropped event volume.",
    hideRoute: {},
  },
});
