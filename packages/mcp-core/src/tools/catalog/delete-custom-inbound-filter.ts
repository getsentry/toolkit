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
  ParamCustomInboundFilterId,
  rethrowCustomInboundFilterError,
} from "./support/custom-inbound-filters";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

export const deleteCustomInboundFilterOutputSchema = z.object({
  success: z.literal(true),
  filterId: z.string(),
  projectSlug: z.string(),
});

export default defineTool({
  name: "delete_custom_inbound_filter",
  skills: ["project-management"],
  requiredScopes: ["project:write"],
  description: [
    "Delete a custom inbound filter so the project ingests the matching errors, logs, metrics or spans again.",
    "",
    "Use this tool when the user wants to permanently remove an inbound filter. To stop a filter temporarily, use update_custom_inbound_filter with active=false instead.",
    "",
    "Be careful when using this tool! Deletion cannot be undone.",
    "",
    "<examples>",
    "delete_custom_inbound_filter(organizationSlug='my-org', projectSlug='my-project', filterId='12345')",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    filterId: ParamCustomInboundFilterId,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  outputSchema: deleteCustomInboundFilterOutputSchema,
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

    setTargetTagsAndAttributes(params);

    await apiService
      .deleteCustomInboundFilter({
        organizationSlug,
        projectSlug: params.projectSlug,
        filterId: params.filterId,
      })
      .catch(rethrowCustomInboundFilterError);

    return structuredResult({
      success: true as const,
      filterId: params.filterId,
      projectSlug: params.projectSlug,
    });
  },
});
