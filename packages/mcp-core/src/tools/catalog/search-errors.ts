import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildDatasetSearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";
import { buildSearchEventsOutputSchema } from "../support/search-events/structured";

export const searchErrorsOutputSchema = buildSearchEventsOutputSchema("errors");

export default defineTool({
  ...searchToolBase("search_errors"),
  name: "search_errors",
  title: "Search Errors",
  description:
    "Search Sentry error events: exceptions, crashes, and stack traces, including top errors and trends over time. Returns individual events, counts, and aggregates; for grouped issue lists, use search_issues. For log lines, including error-level logs, use search_logs.",
  inputSchema: buildDatasetSearchInputSchema(),
  outputSchema: searchErrorsOutputSchema,
  async handler(params, context: ServerContext) {
    return await runSearchEvents({ ...params, dataset: "errors" }, context, {
      lockDataset: true,
      output: "structured",
    });
  },
});
