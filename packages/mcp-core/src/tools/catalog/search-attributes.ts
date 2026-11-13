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
import {
  logSearchEventsError,
  SEARCH_EVENTS_ANNOTATIONS,
} from "../support/search-events/search";

export default defineTool({
  skills: ["inspect"],
  requiredScopes: ["event:read"],
  annotations: SEARCH_EVENTS_ANNOTATIONS,
  onError: (error, params, context) => {
    logSearchEventsError("searchAttributes", error, params, context);
  },
  name: "search_attributes",
  title: "Search Attributes",
  description:
    "Find span, log, or metric attribute keys in Sentry by meaning or partial name, with their types, descriptions, examples, and deprecation status. Alternatively, list the spans, logs, or metric attributes available. Use it to get information about attributes or find the exact key before searching traces, logs, or metrics. For attribute values, use search_traces, search_logs, or search_metrics; for issue tag values, use get_issue_tag_values.",
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
        "Maximum attributes to return. Defaults to 10 with a query and 50 when listing.",
      ),
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
