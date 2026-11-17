import { buildRouteMap } from "../../lib/route-map.js";
import { topLevelBrief } from "../../top-level-briefs.js";
import { completionCommand } from "./completion.js";
import { defaultsCommand } from "./defaults.js";
import { feedbackCommand } from "./feedback.js";
import { fixCommand } from "./fix.js";
import { importCommand } from "./import.js";
import { setupCommand } from "./setup.js";
import { uninstallCommand } from "./uninstall.js";
import { upgradeCommand } from "./upgrade.js";

export const cliRoute = buildRouteMap({
  routes: {
    completion: completionCommand,
    defaults: defaultsCommand,
    feedback: feedbackCommand,
    fix: fixCommand,
    import: importCommand,
    setup: setupCommand,
    uninstall: uninstallCommand,
    upgrade: upgradeCommand,
  },
  docs: {
    brief: topLevelBrief("cli"),
    fullDescription:
      "Commands for managing the Sentry CLI itself, including configuring defaults, " +
      "sending feedback, upgrading to newer versions, and repairing the local database.",
  },
});
