import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamCursor,
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  customInboundFilterItemSchema,
  MAX_FILTERS_PER_PROJECT,
  rethrowCustomInboundFilterError,
  toCustomInboundFilterItem,
} from "./support/custom-inbound-filters";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

const RESULT_LIMIT = 25;

export const findCustomInboundFiltersOutputSchema = z.object({
  filters: z.array(customInboundFilterItemSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export default defineTool({
  name: "find_custom_inbound_filters",
  skills: ["inspect", "project-management"],
  requiredScopes: ["project:read"],
  description: [
    "List the custom inbound filters of a Sentry project: rules that drop errors, logs, metrics or spans at ingest before they count against quota.",
    "",
    "Use this tool when you need to:",
    "- See which events a project ignores or filters out at ingest, and why",
    "- Check whether an error message, release, IP address, log message or metric name is already filtered",
    "- Find a filter ID before update_custom_inbound_filter or delete_custom_inbound_filter",
    "",
    "Each filter has a data type (`error`, `log`, `metric`, `span` or `all`) and conditions on `error_type`, `error_message`, `log_message`, `metric_name`, `release` or `ip_address`. Conditions are ANDed; the values inside one condition are ORed.",
    "",
    "This covers the custom filters only. Built-in inbound filters such as legacy browsers, web crawlers, browser extensions, health checks and localhost are project settings and are not listed here.",
    "",
    `Returns up to ${RESULT_LIMIT} filters per page (a project holds at most ${MAX_FILTERS_PER_PROJECT}). When hasMore is true, pass nextCursor as cursor with the same project.`,
    "",
    "<examples>",
    "find_custom_inbound_filters(organizationSlug='my-org', projectSlug='my-project')",
    "</examples>",
    "",
    "<hints>",
    "- If the user passes a parameter in the form of name/otherName, it is likely in the format of <organizationSlug>/<projectSlug>.",
    "- An inactive filter is kept but drops nothing.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    cursor: ParamCursor.nullable().default(null),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: findCustomInboundFiltersOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    assertProjectRefWithinConstraint({
      resourceLabel: "Custom inbound filter list",
      scopedProjectSlug: context.constraints.projectSlug,
      project: { slug: params.projectSlug },
    });

    setTargetTagsAndAttributes(params);

    const { filters, nextCursor } = await apiService
      .listCustomInboundFilters({
        organizationSlug,
        projectSlug: params.projectSlug,
        limit: RESULT_LIMIT,
        cursor: params.cursor,
      })
      .catch(rethrowCustomInboundFilterError);

    return structuredResult({
      filters: filters.map(toCustomInboundFilterItem),
      hasMore: nextCursor !== null,
      nextCursor,
    });
  },
});
