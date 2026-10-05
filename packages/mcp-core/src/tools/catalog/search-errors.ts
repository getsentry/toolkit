import { defineTool } from "../../internal/tool-helpers/define";
import type { ServerContext } from "../../types";
import {
  buildDatasetSearchInputSchema,
  runSearchEvents,
  searchToolBase,
} from "../support/search-events/search";

export default defineTool({
  ...searchToolBase("search_errors"),
  name: "search_errors",
  description: [
    "Search Sentry error events: exceptions and crashes with stack traces. Use for error counts, statistics, trends, and individual error events.",
    "",
    "`query` is natural language (preferred) or Sentry search syntax; a configured agent translates it into query, fields, and sort.",
    "",
    "Supports aggregations ('how many errors today', 'top error types'), individual events ('latest TypeErrors in checkout'), and time series ('errors per hour last 24h').",
    "",
    "NOT for log messages, including error/warning logs (use search_logs), requests or latency (use search_traces), or grouped issue lists (use search_issues).",
    "",
    "<examples>",
    "search_errors(organizationSlug='my-org', query='how many errors today')",
    "search_errors(organizationSlug='my-org', query='most common error types in production this week')",
    "search_errors(organizationSlug='my-org', query='errors per hour last 24h')",
    "</examples>",
    "",
    "<hints>",
    "- name/otherName notation means <organizationSlug>/<projectSlug>; parse it directly, don't call find_organizations/find_projects.",
    "- Natural language is usually enough. Only pass fields/sort when you need exact columns or ordering.",
    "</hints>",
  ].join("\n"),
  inputSchema: buildDatasetSearchInputSchema(),
  async handler(params, context: ServerContext) {
    return runSearchEvents({ ...params, dataset: "errors" }, context, {
      lockDataset: true,
    });
  },
});
