import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildDatasetSearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";

export default defineTool({
  ...searchToolBase("search_logs"),
  name: "search_logs",
  description: [
    "Search Sentry logs: application log entries, including error- and warning-severity log messages. Use for log counts, statistics, trends, and individual log lines.",
    "",
    "`query` is natural language (preferred) or Sentry search syntax; a configured agent translates it into query, fields, and sort.",
    "",
    "Supports aggregations ('warning logs by service'), individual entries ('error logs from the last hour'), and time series ('error logs per hour').",
    "",
    "NOT for exceptions/crashes (use search_errors). For requests or spans whose trace also has a matching log, use search_traces.",
    "",
    "<examples>",
    "search_logs(organizationSlug='my-org', query='error logs from the last hour')",
    "search_logs(organizationSlug='my-org', query='logs mentioning payment timeout in production')",
    "search_logs(organizationSlug='my-org', query='count warning logs by service over 7 days')",
    "</examples>",
    "",
    "<hints>",
    "- name/otherName notation means <organizationSlug>/<projectSlug>; parse it directly, don't call find_organizations/find_projects.",
    "- Natural language is usually enough. Only pass fields/sort when you need exact columns or ordering.",
    "</hints>",
  ].join("\n"),
  inputSchema: buildDatasetSearchInputSchema(),
  async handler(params, context: ServerContext) {
    return runSearchEvents({ ...params, dataset: "logs" }, context, {
      lockDataset: true,
    });
  },
});
