import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildReplaySearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";
import { searchReplaysOutputSchema } from "../support/search-events/replays";

export default defineTool({
  ...searchToolBase("search_replays"),
  name: "search_replays",
  title: "Search Replays",
  description:
    "Search Sentry session replays by rage clicks, dead clicks, visited pages, errors seen, and users. Returns replay lists, not counts or aggregates.",
  inputSchema: buildReplaySearchInputSchema(),
  outputSchema: searchReplaysOutputSchema,
  async handler(params, context: ServerContext) {
    return await runSearchEvents({ ...params, dataset: "replays" }, context, {
      lockDataset: true,
      output: "structured",
    });
  },
});
