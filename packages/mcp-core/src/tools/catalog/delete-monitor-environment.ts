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

export const deleteMonitorEnvironmentOutputSchema = z.object({
  success: z.literal(true),
  monitorSlug: z.string(),
  projectSlug: z.string(),
  environment: z.string(),
});

export default defineTool({
  name: "delete_monitor_environment",
  skills: ["project-management"],
  requiredScopes: ["project:write"],
  description: [
    "Delete one environment from a Sentry cron monitor.",
    "",
    "Use find_monitors or get_monitor_details to identify the monitor and exact environment name.",
    "",
    "Deletion is irreversible and completes in the background. The monitor and its other environments are preserved. An already absent environment is treated as success.",
    "",
    "<examples>",
    "delete_monitor_environment(organizationSlug='my-organization', projectSlug='backend', monitorSlug='nightly-import', environment='production')",
    "</examples>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    monitorSlug: z.string().trim().min(1).describe("Monitor slug or GUID."),
    environment: z
      .string()
      .min(1)
      .describe(
        "Exact environment name to delete. Preserve whitespace and casing.",
      ),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  outputSchema: deleteMonitorEnvironmentOutputSchema,
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;
    setTargetTagsAndAttributes(params);

    assertProjectRefWithinConstraint({
      resourceLabel: "Cron monitor",
      scopedProjectSlug: context.constraints.projectSlug,
      project: { slug: params.projectSlug },
    });

    await apiService.deleteMonitorEnvironment({
      organizationSlug,
      projectSlug: params.projectSlug,
      monitorSlug: params.monitorSlug,
      environment: params.environment,
    });

    return structuredResult({
      success: true as const,
      environment: params.environment,
      monitorSlug: params.monitorSlug,
      projectSlug: params.projectSlug,
    });
  },
});
