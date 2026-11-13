import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { setTargetTagsAndAttributes } from "../../telem/scope";
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
  title: "Get Metric Monitor Details",
  skills: ["inspect"],
  requiredScopes: ["org:read", "project:read"],
  description: [
    "Get a Sentry Metric Monitor: its query, dataset, detection mode, thresholds, resolution conditions, and connected Alerts.",
    "Condition results: 75 critical, 50 warning, 0 resolved. Percent thresholds are absolute: 110 means 10% higher. Windows are in seconds.",
    "Connected Alerts: get_alert_rule. Cron jobs: find_monitors. URL checks: find_uptime_monitors.",
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
    setTargetTagsAndAttributes({
      organizationSlug: params.organizationSlug,
      projectSlug,
    });
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
