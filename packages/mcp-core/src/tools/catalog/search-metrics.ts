import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildDatasetSearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";

export default defineTool({
  ...searchToolBase("search_metrics"),
  name: "search_metrics",
  description: [
    "Search Sentry metrics: counters, gauges, and distributions, as rows or aggregates. Use for metric values, percentiles, totals, and trends.",
    "",
    "`query` is natural language (preferred) or Sentry search syntax; a configured agent translates it into query, fields, and sort.",
    "",
    "Supports aggregations ('p95 http.request.duration by environment'), individual metric rows, and time series ('total tokens per day this week').",
    "",
    "NOT for span or request latency recorded on traces (use search_traces).",
    "",
    "<examples>",
    "search_metrics(organizationSlug='my-org', query='p95 http.request.duration grouped by environment over the last 24 hours')",
    "search_metrics(organizationSlug='my-org', query='total tokens used per day this week')",
    "</examples>",
    "",
    "<hints>",
    "- name/otherName notation means <organizationSlug>/<projectSlug>; parse it directly, don't call find_organizations/find_projects.",
    "- Natural language is usually enough. Only pass fields/sort when you need exact columns or ordering.",
    "</hints>",
  ].join("\n"),
  inputSchema: buildDatasetSearchInputSchema(),
  async handler(params, context: ServerContext) {
    return runSearchEvents({ ...params, dataset: "metrics" }, context, {
      lockDataset: true,
    });
  },
});
