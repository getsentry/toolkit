import { z } from "zod";
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
  rethrowCustomInboundFilterError,
  toCustomInboundFilterItem,
} from "./support/custom-inbound-filters";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

export const createCustomInboundFilterOutputSchema = z.object({
  filter: customInboundFilterItemSchema,
});

export default defineTool({
  name: "create_custom_inbound_filter",
  skills: ["project-management"],
  requiredScopes: ["project:write"],
  description: [
    "Create a custom inbound filter that drops matching errors, logs, metrics or spans at ingest, before they are stored or count against quota.",
    "",
    "Use this tool when the user wants to:",
    "- Ignore or filter out errors by message or exception type ('stop ingesting *ConnectionError*')",
    "- Drop events from an IP address or CIDR range, or from a release ('block 10.0.0.0/8', 'ignore release 1.4.*')",
    "- Drop noisy logs by message, or metrics by name",
    "- Filter every data type at once with dataType='all' on release or IP address",
    "",
    "Conditions are ANDed; the values inside a condition are ORed. To express 'A or B' put both patterns into one condition's value list. To express 'A and B' use two conditions.",
    "",
    "Be careful when using this tool! An active filter drops data irreversibly. Create it with active=false to review it first.",
    "",
    "<examples>",
    "### Ignore one exception type on errors",
    "create_custom_inbound_filter(organizationSlug='my-org', projectSlug='my-project', name='Ignore flaky connection errors', dataType='error', conditions=[{type: 'error_type', value: ['ConnectionError', 'TimeoutError']}])",
    "",
    "### Drop everything from an IP range for one release",
    "create_custom_inbound_filter(organizationSlug='my-org', projectSlug='my-project', name='Load test traffic', dataType='all', conditions=[{type: 'ip_address', value: ['10.0.0.0/8']}, {type: 'release', value: ['my-app@2.1.*']}])",
    "",
    "### Drop debug logs",
    "create_custom_inbound_filter(organizationSlug='my-org', projectSlug='my-project', name='Drop debug logs', dataType='log', conditions=[{type: 'log_message', value: ['*DEBUG*']}])",
    "</examples>",
    "",
    "<hints>",
    "- Error message conditions match the exception type, the exception value and the formatted message of an event, each on its own. Prefer wildcards such as `*ConnectionError*` over a full message.",
    "- Release conditions match the full release name, e.g. `my-app@1.4.0`; use globs such as `my-app@1.*` for a range.",
    "- Use find_custom_inbound_filters() first to avoid creating a duplicate.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    name: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .describe(
        "A short label that says what the filter drops and why, e.g. 'Ignore flaky connection errors'.",
      ),
    dataType: ParamCustomInboundFilterDataType,
    conditions: ParamCustomInboundFilterConditions,
    active: z
      .boolean()
      .describe(
        "Whether the filter drops data right away. An inactive filter is stored but ignored.",
      )
      .default(true),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  outputSchema: createCustomInboundFilterOutputSchema,
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
    assertConditionsMatchDataType(params.dataType, params.conditions);

    setTargetTagsAndAttributes(params);

    const filter = await apiService
      .createCustomInboundFilter({
        organizationSlug,
        projectSlug: params.projectSlug,
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
