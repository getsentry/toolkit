import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildDatasetSearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";
import { buildSearchEventsOutputSchema } from "../support/search-events/structured";

export const searchMetricsOutputSchema =
  buildSearchEventsOutputSchema("metrics");

export default defineTool({
  ...searchToolBase("search_metrics"),
  name: "search_metrics",
  title: "Search Metrics",
  description:
    "Search Sentry metrics: counters, gauges, and distributions, for values, percentiles, totals, and trends over time. Returns individual events, counts, and aggregates; for grouped issue lists, use search_issues. For latency recorded on spans, use search_traces.",
  inputSchema: buildDatasetSearchInputSchema(),
  outputSchema: searchMetricsOutputSchema,
  async handler(params, context: ServerContext) {
    return await runSearchEvents({ ...params, dataset: "metrics" }, context, {
      lockDataset: true,
      output: "structured",
    });
  },
});
