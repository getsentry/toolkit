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
  description:
    "List span, log, or metric attribute keys in Sentry with their types, descriptions, examples, and deprecation status. Use it to find the exact key before searching traces, logs, or metrics. For attribute values, use search_traces, search_logs, or search_metrics; for issue tag values, use get_issue_tag_values.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    projectSlug: ParamProjectSlug.nullable().default(null),
    query: z
      .string()
      .trim()
      .optional()
      .describe(
        "Not supported yet; the full attribute list is returned either way.",
      ),
    period: ParamPeriod.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    limit: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of attributes to list."),
    dataset: z
      .enum(SEARCH_ATTRIBUTES_DATASETS)
      .optional()
      .describe(
        "Dataset whose attribute keys to list: spans for requests, latency, DB, or AI calls; logs for log lines; metrics for counters, gauges, and distributions.",
      ),
  },
  async handler(params, context: ServerContext) {
    return await runSearchAttributes(params, context);
  },
});
