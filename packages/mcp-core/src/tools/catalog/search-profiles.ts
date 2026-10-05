import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildDatasetSearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";

export default defineTool({
  ...searchToolBase("search_profiles"),
  name: "search_profiles",
  description: [
    "Search Sentry profiles: transaction and continuous profile results, profile IDs, and profiled transactions. Use to find profiles to inspect.",
    "",
    "`query` is natural language (preferred) or Sentry search syntax; a configured agent translates it into query, fields, and sort.",
    "",
    "Use get_profile or get_profile_details on a result for flamegraph and hotspot analysis.",
    "",
    "<examples>",
    "search_profiles(organizationSlug='my-org', query='recent profiles for the /checkout transaction')",
    "</examples>",
    "",
    "<hints>",
    "- name/otherName notation means <organizationSlug>/<projectSlug>; parse it directly, don't call find_organizations/find_projects.",
    "- Natural language is usually enough. Only pass fields/sort when you need exact columns or ordering.",
    "</hints>",
  ].join("\n"),
  inputSchema: buildDatasetSearchInputSchema(),
  async handler(params, context: ServerContext) {
    return runSearchEvents({ ...params, dataset: "profiles" }, context, {
      lockDataset: true,
    });
  },
});
