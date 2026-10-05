import { buildRouteMap } from "../../lib/route-map.js";
import { archiveCommand } from "./archive.js";
import { eventsCommand } from "./events.js";
import { explainCommand } from "./explain.js";
import { listCommand } from "./list.js";
import { mergeCommand } from "./merge.js";
import { planCommand } from "./plan.js";
import { resolveCommand } from "./resolve.js";
import { unresolveCommand } from "./unresolve.js";
import { viewCommand } from "./view.js";

export const issueRoute = buildRouteMap({
  routes: {
    list: listCommand,
    events: eventsCommand,
    explain: explainCommand,
    plan: planCommand,
    view: viewCommand,
    resolve: resolveCommand,
    unresolve: unresolveCommand,
    archive: archiveCommand,
    merge: mergeCommand,
  },
  // `reopen` is a friendlier synonym for `unresolve`, `ignore` for `archive`.
  aliases: { reopen: "unresolve", ignore: "archive" },
  defaultCommand: "view",
  docs: {
    brief: "Manage Sentry issues",
    fullDescription:
      "View and manage issues from your Sentry projects.\n\n" +
      "Commands:\n" +
      "  list       List issues in a project\n" +
      "  events     List events for a specific issue\n" +
      "  view       View details of one or more issues\n" +
      "  explain    Analyze one or more issues using Seer AI\n" +
      "  plan       Generate a solution plan using Seer AI\n" +
      "  resolve    Mark an issue as resolved (optionally in a release)\n" +
      "  unresolve  Reopen a resolved issue (alias: reopen)\n" +
      "  archive    Archive/ignore an issue (alias: ignore)\n" +
      "  merge      Merge 2+ issues into a single group\n\n" +
      "Magic selectors (available for view, events, explain, plan, resolve, unresolve, archive):\n" +
      "  @latest          Most recent unresolved issue\n" +
      "  @most_frequent   Issue with the highest event frequency\n\n" +
      "Examples:\n" +
      "  sentry issue view @latest\n" +
      "  sentry issue view FRONT-ABC BACK-2\n" +
      "  sentry issue explain FRONT-ABC BACK-2\n" +
      "  sentry issue events CLI-G\n" +
      "  sentry issue resolve CLI-12Z --in 0.26.1\n" +
      "  sentry issue archive CLI-AB --until auto\n" +
      "  sentry issue merge CLI-K9 CLI-15H CLI-15N\n" +
      "  sentry issue explain @most_frequent\n" +
      "  sentry issue plan my-org/@latest\n\n" +
      "Alias: `sentry issues` → `sentry issue list`",
    hideRoute: {},
  },
});
