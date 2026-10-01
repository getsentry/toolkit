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
import { setTagAndAttribute } from "../../telem/scope";
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
  skills: ["project-management"],
  requiredScopes: ["org:read", "project:read", "alerts:write"],
  description: [
    "Create a Sentry Metric Monitor with Static, Percent or Dynamic detection in a project.",
    "Provide the complete query, detection config and conditions. Time windows and comparison deltas use seconds. Percent comparisons are absolute: 110 means 10% higher.",
    "To copy a monitor, use the query, config and conditionGroup from get_metric_monitor_details. Component IDs are discarded; new condition groups use logicType='any'.",
    "New monitors start ACTIVE and immediately evaluate data. Initially disabled creation is not supported. Use update_metric_monitor to disable an existing monitor.",
    "workflowIds optionally connect existing notification Alerts, including shared Alerts, without modifying their configuration. Create an Alert separately with create_alert_rule if needed.",
    "Dataset access, quota, aggregate, window and historical-data requirements are enforced by Sentry. Dynamic detection requires sufficient history and Seer availability.",
    "Creation can fail after persisting a monitor, especially during Dynamic setup. After an error or timeout, use find_metric_monitors with the name and project before retrying; do not assume rollback or blindly repeat creation.",
    "create_metric_monitor(organizationSlug='my-org', projectSlug='backend', name='High error count', query={dataset:'events', query:'level:error', aggregate:'count()', eventTypes:['error'], timeWindowSeconds:300}, config={detectionType:'static'}, conditionGroup={conditions:[{type:'gt', comparison:100, conditionResult:75}, {type:'lte', comparison:50, conditionResult:0}]})",
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
    setTagAndAttribute("organization.slug", params.organizationSlug);
    setTagAndAttribute("project.slug", params.projectSlug);
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
