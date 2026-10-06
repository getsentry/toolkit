import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildSearchEventsInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";

/**
 * Legacy multi-dataset search. Kept in the catalog for backward compatibility;
 * new callers use the dataset-specific search_* tools.
 */
export default defineTool({
  ...searchToolBase("search_events"),
  name: "search_events",
  includeInSkillDefinitions: false,
  description: [
    "Deprecated multi-dataset event search, kept for backward compatibility.",
    "",
    "Use search_errors, search_logs, search_traces, search_metrics, search_profiles, or search_replays for new integrations.",
  ].join("\n"),
  inputSchema: buildSearchEventsInputSchema(),
  async handler(params, context: ServerContext) {
    return runSearchEvents(params, context);
  },
});
