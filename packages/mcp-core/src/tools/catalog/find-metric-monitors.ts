import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlugOrAll,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
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
  title: "Find Metric Monitors",
  skills: ["inspect"],
  requiredScopes: ["org:read", "project:read"],
  description: [
    "Find Sentry Metric Monitors that alert when an error count, latency, log, metric, or crash rate crosses a threshold. Returns monitor IDs, queries, and connected Alerts.",
    "Cron jobs: find_monitors. URL checks: find_uptime_monitors. Notifications: alert rules.",
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
        'Monitor search, such as a name or name:"latency". Matches monitor metadata, not the monitored event query.',
      ),
    cursor: z
      .string()
      .optional()
      .describe("Next cursor from the previous page, with the same filters."),
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
    setTargetTagsAndAttributes({
      organizationSlug: params.organizationSlug,
      projectSlug,
    });
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
