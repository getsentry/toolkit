import { z } from "zod";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import { setTagAndAttribute } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  getMetricMonitor,
  metricMonitorReferenceFields,
} from "../support/metric-monitors";

export default defineTool({
  name: "delete_metric_monitor",
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Permanently delete a Sentry Metric Monitor, preserving its connected Alerts and their other monitors.",
    "Use get_metric_monitor_details to inspect the monitor and obtain its native monitorId. Legacy metric alert IDs are not monitor IDs.",
    "Use update_metric_monitor(status='disabled') to pause detection instead. Deletion also removes an associated legacy metric alert and its incident history when present.",
    "Sentry hides the monitor from normal reads immediately and completes deletion in the background.",
    "delete_metric_monitor(organizationSlug='my-org', monitorId='12345')",
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
    setTagAndAttribute("organization.slug", params.organizationSlug);
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
