import { buildRouteMap } from "../../lib/route-map.js";
import { listCommand } from "./list.js";
import { sendCommand } from "./send.js";
import { viewCommand } from "./view.js";

export const eventRoute = buildRouteMap({
  routes: {
    view: viewCommand,
    list: listCommand,
    send: sendCommand,
  },
  defaultCommand: "view",
  docs: {
    brief: "View, list, and send Sentry events",
    fullDescription:
      "View, list, and send event data from Sentry.\n\n" +
      "Use 'sentry event view <event-id>' to view a specific event.\n" +
      "Use 'sentry event list <issue-id>' to list events for an issue.\n" +
      "Use 'sentry event send -m <message>' to send a test event.",
    hideRoute: {},
  },
});
