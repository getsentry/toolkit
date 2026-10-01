import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  getMetricMonitor,
  metricMonitorDetailsSchema,
  metricMonitorReferenceFields,
  toMetricMonitorDetails,
} from "../support/metric-monitors";

export const getMetricMonitorDetailsOutputSchema = z.object({
  monitor: metricMonitorDetailsSchema,
});

export default defineTool({
  name: "get_metric_monitor_details",
  skills: ["inspect"],
  requiredScopes: ["org:read", "project:read"],
  description: [
    "Inspect a Sentry Metric Monitor's query, dataset, detection mode, thresholds, resolution conditions and connected Alerts.",
    "Use monitorId from find_metric_monitors, not a legacy metric alert ID. Time windows and comparison deltas are in seconds.",
    "Condition results use 75 for critical, 50 for warning and 0 for resolved. Percent comparisons are absolute percentages (110 means 10% higher); dynamic conditions include sensitivity and direction.",
    "workflowIds identify notification Alerts; inspect their actions with get_alert_rule(kind='issue').",
    "get_metric_monitor_details(organizationSlug='my-org', monitorId='12345')",
  ].join("\n"),
  inputSchema: metricMonitorReferenceFields,
  outputSchema: getMetricMonitorDetailsOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const projectSlug = context.constraints.projectSlug ?? params.projectSlug;
    setTagAndAttribute("organization.slug", params.organizationSlug);
    if (projectSlug) setTagAndAttribute("project.slug", projectSlug);
    const api = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const detector = await getMetricMonitor(api, {
      ...params,
      scopedProjectSlug: context.constraints.projectSlug,
    });
    return structuredResult({
      monitor: toMetricMonitorDetails(api, params.organizationSlug, detector),
    });
  },
});
