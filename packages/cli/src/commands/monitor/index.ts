import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { metricRoute } from "./metric/index.js";
import { cronRoute } from "./cron/index.js";
import { listCommand } from "./list.js";

export const monitorRoute = buildRouteMap({
  routes: {
    list: listCommand,
    metric: metricRoute,
    cron: cronRoute,
  },
  docs: {
    brief: topLevelBrief("monitor"),
    fullDescription:
      "List Sentry monitors of every type with `sentry monitor list`. Use `sentry monitor metric` for metric monitors and `sentry monitor cron` for cron monitors and command check-ins.\n\n" +
      "Alias: `sentry monitors` → `sentry monitor`",
  },
});
