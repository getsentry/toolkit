import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildDatasetSearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";
import { buildSearchEventsOutputSchema } from "../support/search-events/structured";

export const searchProfilesOutputSchema =
  buildSearchEventsOutputSchema("profiles");

export default defineTool({
  ...searchToolBase("search_profiles"),
  name: "search_profiles",
  title: "Search Profiles",
  description:
    "Search Sentry profiles: transaction and continuous profiles, to find profile IDs and profiled transactions. Returns individual events, counts, and aggregates; for grouped issue lists, use search_issues. Open a result with get_profile or get_profile_details for flamegraphs and hotspots.",
  inputSchema: buildDatasetSearchInputSchema(),
  outputSchema: searchProfilesOutputSchema,
  async handler(params, context: ServerContext) {
    return await runSearchEvents({ ...params, dataset: "profiles" }, context, {
      lockDataset: true,
      output: "structured",
    });
  },
});
