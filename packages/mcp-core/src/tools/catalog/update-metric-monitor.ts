import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  metricMonitorConfigFields,
  toMetricMonitorUpdate,
} from "../support/metric-monitor-config";
import {
  getMetricMonitor,
  metricMonitorDetailsSchema,
  metricMonitorReferenceFields,
  toMetricMonitorDetails,
} from "../support/metric-monitors";

export default defineTool({
  name: "update_metric_monitor",
  title: "Update Metric Monitor",
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Update a Sentry Metric Monitor: its query, detection mode and conditions, name, owner, status, or connected Alerts. Omitted fields stay unchanged.",
    "Read it with get_metric_monitor_details first. Alert notification actions change with update_alert_rule. Cron jobs: find_monitors. URL checks: find_uptime_monitors.",
  ].join("\n"),
  inputSchema: {
    ...metricMonitorReferenceFields,
    ...metricMonitorConfigFields,
  },
  outputSchema: z.object({ monitor: metricMonitorDetailsSchema }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    // Conditions without IDs create new components on each invocation.
    idempotentHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const {
      organizationSlug,
      regionUrl,
      monitorId,
      projectSlug: requestedProject,
      ...changes
    } = params;
    const projectSlug = context.constraints.projectSlug ?? requestedProject;
    setTargetTagsAndAttributes({ organizationSlug, projectSlug });
    const api = apiServiceFromContext(context, {
      regionUrl: regionUrl ?? undefined,
    });
    const current = await getMetricMonitor(api, {
      organizationSlug,
      monitorId,
      projectSlug: requestedProject,
      scopedProjectSlug: context.constraints.projectSlug,
    });
    const updated = await api.updateMetricMonitor({
      organizationSlug,
      monitorId,
      body: toMetricMonitorUpdate(current, changes),
    });
    return structuredResult({
      monitor: toMetricMonitorDetails(api, organizationSlug, updated),
    });
  },
});
