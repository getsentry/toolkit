import { buildRouteMap } from "../../lib/route-map.js";
import { deleteCommand } from "./delete.js";
import { listCommand } from "./list.js";

export const integrationRoute = buildRouteMap({
  routes: {
    list: listCommand,
    delete: deleteCommand,
  },
  docs: {
    brief: "Work with Sentry integrations",
    fullDescription:
      "List and remove integrations (GitHub, GitLab, Slack, Jira, ...) installed on your Sentry organizations.\n\n" +
      "Alias: `sentry integrations` → `sentry integration list`",
    hideRoute: {},
  },
});
