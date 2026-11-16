import { z } from "zod";
import type { Detector } from "../../api-client/types";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  metricMonitorCreateFields,
  toMetricDetectionConfig,
} from "../support/metric-monitor-config";
import {
  metricMonitorDetailsSchema,
  toMetricMonitorDetails,
} from "../support/metric-monitors";
import { assertProjectRefWithinConstraint } from "./support/project-constraints";

export default defineTool({
  name: "create_metric_monitor",
  title: "Create Metric Monitor",
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Create a Sentry Metric Monitor that detects when a metric, such as an error count or latency, crosses a static, percent-change, or dynamic threshold. New monitors start active.",
    "Copy a monitor's setup from get_metric_monitor_details. Notifications come from Alerts: create_alert_rule. Cron jobs: find_monitors. URL checks: find_uptime_monitors.",
    "Creation can persist before an error or timeout; check find_metric_monitors before retrying.",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    projectSlug: ParamProjectSlug,
    ...metricMonitorCreateFields,
  },
  outputSchema: z.object({
    monitor: metricMonitorDetailsSchema,
    guidance: z.string().optional(),
  }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    assertProjectRefWithinConstraint({
      resourceLabel: "Metric Monitor",
      scopedProjectSlug: context.constraints.projectSlug,
      project: { slug: params.projectSlug },
    });
    const api = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    setTargetTagsAndAttributes(params);
    const { timeWindowSeconds, ...query } = params.query;
    const body = {
      type: "metric_issue" as const,
      name: params.name,
      description: params.description,
      owner: params.owner,
      config: toMetricDetectionConfig(
        params.config,
        params.conditionGroup.conditions,
      ),
      conditionGroup: params.conditionGroup,
      dataSources: [{ ...query, timeWindow: timeWindowSeconds }],
      workflowIds: params.workflowIds,
    };
    let created: Detector;
    try {
      created = await api.createMetricMonitor({
        organizationSlug: params.organizationSlug,
        projectSlug: params.projectSlug,
        body,
      });
    } catch (error) {
      // Preserve the API error class so client/server failures retain their logging behavior.
      if (error instanceof Error) {
        error.message +=
          "\nCreation may have partially succeeded. Use find_metric_monitors with the name and project before retrying; inspect or delete any created monitor first.";
      }
      throw error;
    }
    const monitor = toMetricMonitorDetails(
      api,
      params.organizationSlug,
      created,
    );
    return structuredResult({
      monitor,
      ...(monitor.workflowIds.length === 0
        ? {
            guidance:
              "This monitor has no connected Alerts. Connect an Alert with update_metric_monitor to configure notifications.",
          }
        : {}),
    });
  },
});
