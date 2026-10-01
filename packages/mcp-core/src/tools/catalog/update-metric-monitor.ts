import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { setTagAndAttribute } from "../../telem/scope";
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
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Update a Sentry Metric Monitor's query, detection conditions, metadata, status or connected Alerts.",
    "Use get_metric_monitor_details first and its native monitorId, not a legacy metric alert ID. projectSlug identifies scope; it does not move the monitor.",
    "Omit fields to preserve them. query and config accept partial changes. conditionGroup and workflowIds replace their complete configuration; preserve IDs and entries you want to retain.",
    "Static, Percent and Dynamic detection are supported. Windows and comparison deltas are in seconds. Percent thresholds are absolute (110 means 10% higher), not percentage changes.",
    "Dynamic changes may require sufficient historical data. Dataset access, query and window constraints are enforced by Sentry.",
    "workflowIds connect existing Alerts, including shared Alerts, without editing their actions or other monitors. Use update_alert_rule for notification configuration.",
    "Requires alerts:write; reconnect OAuth if the existing token lacks it.",
    "update_metric_monitor(organizationSlug='my-org', monitorId='12345', status='disabled')",
    "update_metric_monitor(organizationSlug='my-org', monitorId='12345', query={query:'level:error', timeWindowSeconds:300})",
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
    setTagAndAttribute("organization.slug", organizationSlug);
    if (projectSlug) setTagAndAttribute("project.slug", projectSlug);
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
