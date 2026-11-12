import z from "zod";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  ParamOrganizationSlug,
  ParamPeriod,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import type { ServerContext } from "../../types";
import {
  SEARCH_ATTRIBUTES_DATASETS,
  runSearchAttributes,
} from "../support/search-attributes/search";
import { searchToolBase } from "../support/search-events/search";

export default defineTool({
  ...searchToolBase("search_attributes"),
  experimental: true,
  includeInSkillDefinitions: false,
  name: "search_attributes",
  title: "Search Attributes",
  // TODO: Edit this description to incoporate searching
  description: [
    "Find span, log, or metric attribute keys in Sentry: which attributes exist, their types, short descriptions, examples, and whether they're deprecated.",
    "",
    "Use before search_traces, search_logs, or search_metrics when you don't know the exact attribute key, or to check whether an attribute is still being sent.",
    "",
    "`query` is plain English or part of a key. Omit it to list the dataset's attributes.",
    "",
    "Lists the dataset's attributes seen in `period`, with Sentry's common search fields first. Searching by `query` will narrow down the search and surface the best candidates.",
    "",
    "NOT for attribute values or event data (use search_traces, search_logs, or search_metrics), or issue tag values (use get_issue_tag_values).",
    "",
    "<examples>",
    "search_attributes(organizationSlug='my-org', dataset='spans')",
    "search_attributes(organizationSlug='my-org', projectSlug='backend', dataset='logs')",
    "search_attributes(organizationSlug='my-org', dataset='metrics', period='7d')",
    "search_attributes(organizationSlug='my-org', query='HTTP status code', dataset='spans')",
    "search_attributes(organizationSlug='my-org', projectSlug='backend', query='request ID that ties log lines to a trace', dataset='logs')",
    "search_attributes(organizationSlug='my-org', query='payment provider', dataset='metrics', period='7d')",
    "</examples>",
    "",
    "<hints>",
    "- name/otherName notation means <organizationSlug>/<projectSlug>; parse it directly, don't call find_organizations/find_projects.",
    "- Infer dataset from the question: spans for requests, latency, DB, or AI calls; logs for log lines; metrics for counters, gauges, and distributions.",
    "- Show the user each returned attribute's type, description, examples, deprecation status and if they were added by Sentry. Don't reduce the result to a list of names.",
    "- Pass a returned key to the matching search tool to query its values.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    projectSlug: ParamProjectSlug.nullable().default(null),
    query: z
      .string()
      .trim()
      .optional()
      .describe(
        "What attribute to find, in plain English or as part of a key. Omit to list the dataset's attributes.",
      ),
    period: ParamPeriod.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    limit: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Maximum number of attributes to return (1-100). Defaults to 10 with a `query` and 50 when listing.",
      ),
    dataset: z
      .enum(SEARCH_ATTRIBUTES_DATASETS)
      .optional()
      .describe(
        "Which dataset's attributes to list: spans, logs, or metrics. Infer it from the question; ask the user to clarify if it cannot be inferred.",
      ),
  },
  async handler(params, context: ServerContext) {
    return await runSearchAttributes(params, context);
  },
});
