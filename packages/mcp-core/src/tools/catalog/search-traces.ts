import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildDatasetSearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";

export default defineTool({
  ...searchToolBase("search_traces"),
  name: "search_traces",
  description: [
    "Search Sentry spans and traces: requests, API/HTTP calls, endpoints, DB queries, AI/LLM calls, and other operations. Use for latency, throughput, slowness, and performance questions.",
    "",
    "`query` is natural language (preferred) or Sentry search syntax; a configured agent translates it into query, fields, and sort.",
    "",
    "Also use for spans whose trace contains a matching log, metric, or other span, e.g. 'slow checkout requests that also logged an error'.",
    "",
    "Supports aggregations ('p95 duration by span.op'), individual spans ('slowest API calls today'), and time series ('requests per minute last hour').",
    "",
    "NOT for exceptions/crashes (use search_errors), standalone log lines (use search_logs), or a single trace's span tree (use get_sentry_resource with the trace).",
    "",
    "<examples>",
    "search_traces(organizationSlug='my-org', query='slowest API calls in the last 24 hours')",
    "search_traces(organizationSlug='my-org', query='p95 duration of db spans grouped by span.op over 7 days')",
    "search_traces(organizationSlug='my-org', query='checkout requests that also have an error log')",
    "</examples>",
    "",
    "<hints>",
    "- name/otherName notation means <organizationSlug>/<projectSlug>; parse it directly, don't call find_organizations/find_projects.",
    "- Natural language is usually enough. Only pass fields/sort when you need exact columns or ordering.",
    "</hints>",
  ].join("\n"),
  inputSchema: buildDatasetSearchInputSchema(),
  async handler(params, context: ServerContext) {
    return runSearchEvents({ ...params, dataset: "spans" }, context, {
      lockDataset: true,
    });
  },
});
