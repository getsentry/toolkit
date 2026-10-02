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
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

export const deleteUptimeMonitorOutputSchema = z.object({
  success: z.literal(true),
  uptimeMonitorId: z.string(),
  projectSlug: z.string(),
});

export default defineTool({
  name: "delete_uptime_monitor",
  skills: ["project-management"],
  requiredScopes: ["project:write"],
  description: [
    "Delete a Sentry HTTP uptime monitor.",
    "",
    "Use this tool when you need to permanently remove an uptime monitor.",
    "",
    "Be careful when using this tool! Deletion cannot be undone.",
    "",
    "<examples>",
    "delete_uptime_monitor(organizationSlug='my-organization', projectSlug='backend', uptimeMonitorId='12345')",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    uptimeMonitorId: z
      .string()
      .trim()
      .min(1)
      .describe("Uptime monitor ID (detector id)."),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  outputSchema: deleteUptimeMonitorOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTargetTagsAndAttributes(params);

    assertProjectRefWithinConstraint({
      resourceLabel: "Uptime monitor",
      scopedProjectSlug: context.constraints.projectSlug,
      project: { slug: params.projectSlug },
    });

    await apiService.deleteUptimeMonitor({
      organizationSlug,
      projectSlug: params.projectSlug,
      uptimeMonitorId: params.uptimeMonitorId,
    });

    return structuredResult({
      success: true as const,
      uptimeMonitorId: params.uptimeMonitorId,
      projectSlug: params.projectSlug,
    });
  },
});
