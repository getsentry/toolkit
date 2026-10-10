import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildReplaySearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";

export default defineTool({
  ...searchToolBase("search_replays"),
  name: "search_replays",
  description: [
    "Search Sentry session replays: rage clicks, dead clicks, visited pages, errors seen, and replay users.",
    "",
    "`query` is natural language (preferred) or replay search syntax; a configured agent translates it into a replay search.",
    "",
    "Returns replay lists only; count()/avg()/sum() are not supported. Use get_replay_details on a result for one replay.",
    "",
    "<examples>",
    "search_replays(organizationSlug='my-org', query='replays with rage clicks on checkout in the last day')",
    "search_replays(organizationSlug='my-org', query='count_errors:>0', sort='-count_errors')",
    "</examples>",
    "",
    "<hints>",
    "- name/otherName notation means <organizationSlug>/<projectSlug>; parse it directly, don't call find_organizations/find_projects.",
    "</hints>",
  ].join("\n"),
  inputSchema: buildReplaySearchInputSchema(),
  async handler(params, context: ServerContext) {
    return runSearchEvents({ ...params, dataset: "replays" }, context, {
      lockDataset: true,
    });
  },
});
