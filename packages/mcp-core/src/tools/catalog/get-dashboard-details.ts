import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { ParamOrganizationSlug, ParamRegionUrl } from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  assertDashboardWithinProjectConstraint,
  dashboardDetailsSchema,
  resolveDashboardId,
  resolveDashboardProjectConstraint,
  toDashboardDetails,
} from "../support/dashboards";

export const getDashboardDetailsOutputSchema = z.object({
  dashboard: dashboardDetailsSchema,
});

export default defineTool({
  name: "get_dashboard_details",
  title: "Get Dashboard Details",
  skills: ["inspect"],
  requiredScopes: ["org:read"],
  description:
    "Get one Sentry dashboard by numeric ID or exact title: its widgets with saved query definitions and transformations, projects, environments, filters, and layout. Returns saved queries, not live widget data. To find a dashboard, use find_dashboards.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    dashboardIdOrTitle: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The dashboard's numeric ID or exact title; a title must match exactly one dashboard, ignoring case.",
      ),
  },
  outputSchema: getDashboardDetailsOutputSchema,
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

    return structuredResult({
      dashboard: toDashboardDetails({
        dashboard,
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
      }),
    });
  },
});
