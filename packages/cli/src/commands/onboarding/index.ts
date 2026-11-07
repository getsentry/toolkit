import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { progressCommand } from "./progress.js";

export const onboardingRoute = buildRouteMap({
  routes: {
    progress: progressCommand,
  },
  docs: {
    brief: topLevelBrief("onboarding"),
    fullDescription:
      "Report agent onboarding progress to Sentry.\n\n" +
      "Use `sentry onboarding progress` during a Sentry setup workflow to update\n" +
      "the onboarding page as each stage completes.",
    hideRoute: {},
  },
});
