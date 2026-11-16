import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildDatasetSearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";
import { buildSearchEventsOutputSchema } from "../support/search-events/structured";

export const searchTracesOutputSchema = buildSearchEventsOutputSchema("spans");

export default defineTool({
  ...searchToolBase("search_traces"),
  name: "search_traces",
  title: "Search Traces",
  description:
    "Search Sentry traces and spans: requests, endpoints, HTTP and DB calls, and AI/LLM calls, for latency, throughput, and slowness over time. Also finds spans whose trace has a matching log, metric, or span. Returns individual events, counts, and aggregates; for grouped issue lists, use search_issues. For exceptions, use search_errors; for log lines, use search_logs.",
  inputSchema: buildDatasetSearchInputSchema(),
  outputSchema: searchTracesOutputSchema,
  async handler(params, context: ServerContext) {
    return await runSearchEvents({ ...params, dataset: "spans" }, context, {
      lockDataset: true,
      output: "structured",
    });
  },
});
