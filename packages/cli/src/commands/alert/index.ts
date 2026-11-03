import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { issuesRoute } from "./issues/index.js";
import { metricsRoute } from "./metrics/index.js";

export const alertRoute = buildRouteMap({
  routes: {
    issues: issuesRoute,
    metrics: metricsRoute,
  },
  docs: {
    brief: topLevelBrief("alert"),
    fullDescription:
      "View and manage alert rules in your Sentry organization.\n\n" +
      "Alert types:\n" +
      "  issues    Issue alert rules — trigger on matching error events (project-scoped)\n" +
      "  metrics   Metric alert rules — trigger on metric query thresholds (org-scoped)",
    hideRoute: {},
  },
});
