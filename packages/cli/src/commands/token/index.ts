import { buildRouteMap } from "../../lib/route-map.js";
import { createCommand } from "./create.js";
import { deleteCommand } from "./delete.js";
import { listCommand } from "./list.js";

export const tokenRoute = buildRouteMap({
  routes: {
    list: listCommand,
    create: createCommand,
    delete: deleteCommand,
  },
  docs: {
    brief: "Manage org auth tokens",
    fullDescription:
      "Create, list, and revoke org auth tokens: the org:ci tokens used to upload " +
      "source maps, debug files, and releases from CI.\n\n" +
      "Needs a CLI login from `sentry auth login`. The first token command asks " +
      "you to re-authorize so the login can manage org auth tokens.\n\n" +
      "Alias: `sentry tokens` → `sentry token list`",
  },
});
