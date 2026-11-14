import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  getMetricMonitor,
  metricMonitorReferenceFields,
} from "../support/metric-monitors";

export default defineTool({
  name: "delete_metric_monitor",
  title: "Delete Metric Monitor",
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Permanently delete a Sentry Metric Monitor, and its legacy metric alert and incident history if present. Connected Alerts are kept.",
    "To pause detection instead, use update_metric_monitor. Cron jobs: find_monitors. URL checks: find_uptime_monitors.",
  ].join("\n"),
  inputSchema: metricMonitorReferenceFields,
  outputSchema: z.object({ success: z.literal(true), monitorId: z.string() }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const api = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    setTargetTagsAndAttributes(params);
    await getMetricMonitor(api, {
      ...params,
      scopedProjectSlug: context.constraints.projectSlug,
    });
    await api.deleteMetricMonitor({
      organizationSlug: params.organizationSlug,
      monitorId: params.monitorId,
    });
    return structuredResult({
      success: true as const,
      monitorId: params.monitorId,
    });
  },
});
