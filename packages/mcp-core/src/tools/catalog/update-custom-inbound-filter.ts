import { z } from "zod";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  assertConditionsMatchDataType,
  customInboundFilterItemSchema,
  ParamCustomInboundFilterConditions,
  ParamCustomInboundFilterDataType,
  ParamCustomInboundFilterId,
  rethrowCustomInboundFilterError,
  toCustomInboundFilterItem,
} from "./support/custom-inbound-filters";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

export const updateCustomInboundFilterOutputSchema = z.object({
  filter: customInboundFilterItemSchema,
});

export default defineTool({
  name: "update_custom_inbound_filter",
  skills: ["project-management"],
  requiredScopes: ["project:write"],
  description: [
    "Update a custom inbound filter: rename it, pause or resume it, or change what it drops at ingest.",
    "",
    "Use this tool when the user wants to:",
    "- Pause a filter without deleting it (active=false) or turn it back on",
    "- Add or remove a pattern, e.g. another error message, release or IP range",
    "- Rename a filter or move it to another data type",
    "",
    "Only the fields you pass change. `conditions` replaces the whole condition list, so send the complete list you want to keep.",
    "",
    "Be careful when using this tool! Widening an active filter drops more data irreversibly.",
    "",
    "<examples>",
    "### Pause a filter",
    "update_custom_inbound_filter(organizationSlug='my-org', projectSlug='my-project', filterId='12345', active=false)",
    "",
    "### Replace the patterns of a filter",
    "update_custom_inbound_filter(organizationSlug='my-org', projectSlug='my-project', filterId='12345', conditions=[{type: 'error_message', value: ['*ConnectionError*', '*TimeoutError*']}])",
    "</examples>",
    "",
    "<hints>",
    "- Use find_custom_inbound_filters() to get the filterId and the current conditions before you change them.",
    "- When you change dataType, make sure every condition type is one that data type accepts.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    filterId: ParamCustomInboundFilterId,
    name: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .describe("The new label of the filter.")
      .optional(),
    active: z
      .boolean()
      .describe("Set false to pause the filter, true to resume it.")
      .optional(),
    dataType: ParamCustomInboundFilterDataType.optional(),
    conditions: ParamCustomInboundFilterConditions.optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  outputSchema: updateCustomInboundFilterOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    assertProjectRefWithinConstraint({
      resourceLabel: "Custom inbound filter",
      scopedProjectSlug: context.constraints.projectSlug,
      project: { slug: params.projectSlug },
    });

    if (
      params.name === undefined &&
      params.active === undefined &&
      params.dataType === undefined &&
      params.conditions === undefined
    ) {
      throw new UserInputError(
        "Provide at least one of name, active, dataType or conditions to update.",
      );
    }
    if (params.dataType !== undefined && params.conditions !== undefined) {
      assertConditionsMatchDataType(params.dataType, params.conditions);
    }

    setTargetTagsAndAttributes(params);

    const filter = await apiService
      .updateCustomInboundFilter({
        organizationSlug,
        projectSlug: params.projectSlug,
        filterId: params.filterId,
        name: params.name,
        active: params.active,
        dataType: params.dataType,
        conditions: params.conditions,
      })
      .catch(rethrowCustomInboundFilterError);

    return structuredResult({
      filter: toCustomInboundFilterItem(filter),
    });
  },
});
