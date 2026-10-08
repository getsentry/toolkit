import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  assertDashboardWithinProjectConstraint,
  formatDashboardDetails,
  resolveDashboardId,
  resolveDashboardProjectConstraint,
} from "../support/dashboards";

export default defineTool({
  name: "get_dashboard_details",
  skills: ["inspect"],
  requiredScopes: ["org:read"],
  description: [
    "Get detailed information about a specific Sentry dashboard.",
    "",
    "Use this tool when you need to:",
    "- Inspect a dashboard's widgets and saved query definitions",
    "- View dashboard projects, environments, filters, layout, and widget IDs",
    "- Resolve a dashboard by exact title or numeric ID",
    "",
    "<examples>",
    "get_dashboard_details(organizationSlug='my-organization', dashboardIdOrTitle='12345')",
    "get_dashboard_details(organizationSlug='my-organization', dashboardIdOrTitle='Errors Overview')",
    "</examples>",
    "",
    "<hints>",
    "- Numeric dashboard IDs are resolved directly.",
    "- Title lookups require one exact case-insensitive match. Use `find_dashboards` first if uncertain.",
    "- This returns saved widget query definitions, not live widget data.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    dashboardIdOrTitle: z
      .string()
      .trim()
      .min(1)
      .describe("The dashboard's numeric ID or exact title."),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTargetTagsAndAttributes({ organizationSlug });

    const scopedProject = await resolveDashboardProjectConstraint({
      apiService,
      organizationSlug,
      scopedProjectSlug: context.constraints.projectSlug,
    });
    if (scopedProject) {
      setTargetTagsAndAttributes({
        organizationSlug,
        projectSlug: scopedProject.slug,
        projectId: scopedProject.id,
      });
    }

    const dashboardId = await resolveDashboardId({
      apiService,
      organizationSlug,
      dashboardIdOrTitle: params.dashboardIdOrTitle,
      projectId: scopedProject?.id,
    });

    const dashboard = await apiService.getDashboard({
      organizationSlug,
      dashboardId,
    });

    assertDashboardWithinProjectConstraint({
      dashboard,
      scopedProjectSlug: context.constraints.projectSlug,
      projectId: scopedProject?.id,
    });

    return formatDashboardDetails({
      dashboard,
      organizationSlug,
      dashboardUrl: apiService.getDashboardUrl(
        organizationSlug,
        String(dashboard.id),
        {
          projectId:
            scopedProject?.id ??
            (dashboard.projects.length === 1 ? dashboard.projects[0] : null),
          statsPeriod: dashboard.period ?? null,
        },
      ),
    });
  },
});
