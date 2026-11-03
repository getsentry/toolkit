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
  // TODO: Edit this description, figure out what we want it to do
  description: [
    "Find span, log, or metric attribute keys in Sentry: which attributes exist, their types, short descriptions, and whether they're deprecated or follow semantic conventions.",
    "",
    // TODO: put this in after "Use before search_traces, search_logs, or search_metrics"
    "Use when you don't know the exact attribute key, or to check whether an attribute is being sent at all.",
    "",
    "`query` is natural language (preferred) or part of an attribute name; a configured agent turns it into an attribute-name search.",
    "",
    "NOT for attribute values or event data (use search_traces, search_logs, or search_metrics), or issue tag values (use get_issue_tag_values).",
    "",
    "<examples>",
    "search_attributes(organizationSlug='my-org', query='which attribute holds the HTTP status code, so I can group failed requests by it', dataset='spans')",
    "search_attributes(organizationSlug='my-org', query='database query text', dataset='spans')",
    "search_attributes(organizationSlug='my-org', query='gen_ai.usage', dataset='spans', limit=50)",
    "search_attributes(organizationSlug='my-org', query='are we still sending the deprecated HTTP method attribute, and what replaced it', dataset='spans')",
    "search_attributes(organizationSlug='my-org', query='user.id', dataset='spans', period='24h')",
    "search_attributes(organizationSlug='my-org', projectSlug='backend', query='which attribute carries the request ID that ties log lines back to a trace', dataset='logs')",
    "search_attributes(organizationSlug='my-org', query='log level', dataset='logs')",
    "search_attributes(organizationSlug='my-org', projectSlug='frontend', query='which attributes identify payment provider and region, to break down revenue by them', dataset='metrics', period='7d')",
    "</examples>",
    "",
    "<hints>",
    "- name/otherName notation means <organizationSlug>/<projectSlug>; parse it directly, don't call find_organizations/find_projects.",
    "- Infer dataset from the question: spans for requests, latency, DB, or AI calls; logs for log lines; metrics for counters, gauges, and distributions.",
    "- Omit `query` to list all attributes in the dataset.",
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
        "What attribute to find, in natural language or as part of an attribute name. Omit to list attributes in the dataset.",
      ),
    period: ParamPeriod.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe("Maximum number of attributes to return (1-100)"),
    dataset: z
      .enum(SEARCH_ATTRIBUTES_DATASETS)
      .optional()
      .describe(
        "Which dataset's attributes to search: spans, logs, or metrics. Infer it from the question; ask the user to clarify if it cannot be inferred.",
      ),
  },
  async handler(params, context: ServerContext) {
    return await runSearchAttributes(params, context);
  },
});
