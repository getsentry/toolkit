import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlugOrAll,
  ParamRegionUrl,
} from "../../schema";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  listMetricMonitors,
  metricMonitorSummarySchema,
  toMetricMonitorSummary,
} from "../support/metric-monitors";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

export const findMetricMonitorsOutputSchema = z.object({
  monitors: z.array(metricMonitorSummarySchema),
  nextCursor: z.string().nullable(),
});

export default defineTool({
  name: "find_metric_monitors",
  skills: ["inspect"],
  requiredScopes: ["org:read", "project:read"],
  description: [
    "Find Sentry Metric Monitors that evaluate errors, performance, logs, metrics or crash rates.",
    "Use this tool to find a monitor ID before inspecting its query and detection conditions with get_metric_monitor_details.",
    "Results contain native monitor IDs, separate from legacy metric alert IDs. Alerts connected through workflowIds control notifications; inspect them with get_alert_rule(kind='issue').",
    "Omit projectSlug to search all accessible projects. Pass nextCursor as cursor with the same filters to retrieve more results.",
    "find_metric_monitors(organizationSlug='my-org', projectSlug='backend', query='latency')",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlugOrAll.optional(),
    query: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Optional monitor search, such as a name or name:"latency". This searches monitor metadata, not the monitored event query. Results are always restricted to Metric Monitors.',
      ),
    cursor: z
      .string()
      .optional()
      .describe("nextCursor from the previous page."),
    limit: z.number().int().min(1).max(100).default(10),
  },
  outputSchema: findMetricMonitorsOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const requestedProject =
      params.projectSlug === "all" ? undefined : params.projectSlug;
    if (requestedProject) {
      assertProjectRefWithinConstraint({
        resourceLabel: "Metric Monitor list",
        scopedProjectSlug: context.constraints.projectSlug,
        project: { slug: requestedProject },
      });
    }
    const projectSlug = context.constraints.projectSlug ?? requestedProject;
    setTagAndAttribute("organization.slug", params.organizationSlug);
    if (projectSlug) setTagAndAttribute("project.slug", projectSlug);
    const api = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const page = await listMetricMonitors(api, { ...params, projectSlug });
    return structuredResult({
      monitors: page.detectors.map((detector) =>
        toMetricMonitorSummary(api, params.organizationSlug, detector),
      ),
      nextCursor: page.nextCursor,
    });
  },
});
