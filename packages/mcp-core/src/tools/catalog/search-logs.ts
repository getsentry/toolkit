import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildDatasetSearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";
import { buildSearchEventsOutputSchema } from "../support/search-events/structured";

export const searchLogsOutputSchema = buildSearchEventsOutputSchema("logs");

export default defineTool({
  ...searchToolBase("search_logs"),
  name: "search_logs",
  title: "Search Logs",
  description:
    "Search Sentry logs: application log lines at any severity, including trends over time. Returns individual events, counts, and aggregates; for grouped issue lists, use search_issues. For exceptions and crashes, use search_errors; for requests whose trace has a matching log, use search_traces.",
  inputSchema: buildDatasetSearchInputSchema({
    queryDescription:
      "What to find, in natural language or Sentry search syntax. Put environment and release filters here. Regex filters are unquoted RE2: message://timeout \\d+ms//",
  }),
  outputSchema: searchLogsOutputSchema,
  async handler(params, context: ServerContext) {
    return await runSearchEvents({ ...params, dataset: "logs" }, context, {
      lockDataset: true,
      output: "structured",
    });
  },
});
