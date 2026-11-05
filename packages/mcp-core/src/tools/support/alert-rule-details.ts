import { z } from "zod";
import type { SentryApiService } from "../../api-client";
import { ApiNotFoundError, ApiPermissionError } from "../../api-client";
import type { IssueAlertRule } from "../../api-client/types";
import { isPlainObject } from "../../internal/type-guards";
import { formatActor, formatDate } from "../catalog/support/api-formatting";
import {
  conditionGroupSchema,
  getMetricQuery,
  metricQueryDetailsSchema,
} from "./detector-details";

const componentId = z.union([z.string(), z.number()]);
const actionGroupSchema = conditionGroupSchema.extend({
  actions: z.array(
    z.object({
      id: componentId.optional(),
      type: z.string(),
      integrationId: componentId.nullable().optional(),
      config: z.record(z.string(), z.unknown()),
      data: z.record(z.string(), z.unknown()),
      status: z.string().optional(),
    }),
  ),
});

const uptimeQuerySchema = z.object({
  url: z.string(),
  method: z.string(),
  intervalSeconds: z.number(),
  timeoutMs: z.number(),
  assertion: z.unknown(),
  traceSampling: z.boolean().optional(),
  responseCaptureEnabled: z.boolean().optional(),
});
const cronQuerySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  isMuted: z.boolean(),
  config: z.object({
    schedule_type: z.string(),
    schedule: z.union([z.string(), z.array(z.union([z.number(), z.string()]))]),
    checkin_margin: z.number().nullable().optional(),
    max_runtime: z.number().nullable().optional(),
    timezone: z.string().nullable().optional(),
    failure_issue_threshold: z.number().nullable().optional(),
    recovery_threshold: z.number().nullable().optional(),
  }),
  environments: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      isMuted: z.boolean(),
    }),
  ),
});

/**
 * Detector config keys from the metric and uptime detector config schemas in
 * getsentry/sentry (incidents/grouptype.py, uptime/grouptype.py), camelCased
 * by DetectorSerializer. Other keys, such as error detector project options,
 * are dropped instead of passed through.
 */
const detectorConfigSchema = z.object({
  detectionType: z.string().optional(),
  comparisonDeltaSeconds: z.number().nullable().optional(),
  mode: z
    .number()
    .optional()
    .describe("Raw integer detector mode from Sentry."),
  environment: z.string().nullable().optional(),
  recoveryThreshold: z.number().optional(),
  downtimeThreshold: z.number().optional(),
});

const unavailableDataSourceSchema = z.object({
  type: z.string(),
  unavailableReason: z.string(),
});

const dataSourceSchema = z.union([
  z.object({ type: z.string(), query: metricQueryDetailsSchema }),
  z.object({
    type: z.string(),
    query: uptimeQuerySchema,
    omittedFields: z.array(z.string()),
  }),
  z.object({ type: z.string(), query: cronQuerySchema }),
  unavailableDataSourceSchema,
]);

const alertRuleSourceSchema = z.discriminatedUnion("status", [
  z.object({
    id: z.string(),
    status: z.literal("available"),
    name: z.string(),
    type: z.string(),
    projectId: z.string().nullable(),
    enabled: z.boolean(),
    config: detectorConfigSchema,
    conditionGroup: conditionGroupSchema.nullable(),
    dataSources: z.array(dataSourceSchema),
  }),
  z.object({
    id: z.string(),
    status: z.literal("outside_project_constraint"),
  }),
  z.object({
    id: z.string(),
    status: z.literal("unavailable"),
    reason: z.string(),
  }),
]);

/** Issue Alert (workflow) details returned by get_alert_rule. */
export const alertRuleDetailsSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  config: z.object({ frequency: z.number().optional() }),
  environment: z.string().nullable().optional(),
  owner: z.string().nullable(),
  dateCreated: z.string().nullable(),
  dateUpdated: z.string().nullable(),
  lastTriggered: z.string().nullable(),
  triggers: conditionGroupSchema.nullable(),
  actionFilters: z.array(actionGroupSchema),
  scope: z.object({
    includesAllProjects: z.boolean(),
    projectIds: z.array(z.string()),
    limitedToProject: z.string().nullable().optional(),
    outsideProjectCount: z.number().optional(),
  }),
  sources: z.array(alertRuleSourceSchema),
  webUrl: z.string(),
});

export type AlertRuleDetails = z.infer<typeof alertRuleDetailsSchema>;

const DETECTOR_CONFIG_FIELDS: ReadonlyArray<
  [keyof typeof detectorConfigSchema.shape, string]
> = [
  ["detectionType", "detectionType"],
  ["comparisonDeltaSeconds", "comparisonDelta"],
  ["mode", "mode"],
  ["environment", "environment"],
  ["recoveryThreshold", "recoveryThreshold"],
  ["downtimeThreshold", "downtimeThreshold"],
];

function toDetectorConfig(
  type: string,
  config: Record<string, unknown>,
): z.infer<typeof detectorConfigSchema> {
  if (type === "issue_stream") {
    return {};
  }
  const mapped: Record<string, unknown> = {};
  for (const [key, sourceKey] of DETECTOR_CONFIG_FIELDS) {
    // Read each field on its own so one malformed value doesn't drop the rest.
    const parsed = detectorConfigSchema.shape[key].safeParse(config[sourceKey]);
    if (parsed.success && parsed.data !== undefined) {
      mapped[key] = parsed.data;
    }
  }
  return detectorConfigSchema.parse(mapped);
}

function sourceDetails(
  source: Record<string, unknown>,
): z.infer<typeof dataSourceSchema> {
  const type = typeof source.type === "string" ? source.type : "unknown";
  const query = source.queryObj;
  const unavailable = {
    type,
    unavailableReason: "Source configuration is unavailable.",
  };
  if (!isPlainObject(query)) {
    return unavailable;
  }
  if (type === "snuba_query_subscription") {
    const metricQuery = getMetricQuery(source);
    return metricQuery ? { type, query: metricQuery } : unavailable;
  }
  if (type === "uptime_subscription") {
    const parsed = uptimeQuerySchema.safeParse(query);
    return parsed.success
      ? { type, query: parsed.data, omittedFields: ["headers", "body"] }
      : unavailable;
  }
  if (type === "cron_monitor") {
    const parsed = cronQuerySchema.safeParse(query);
    return parsed.success ? { type, query: parsed.data } : unavailable;
  }
  return {
    type,
    unavailableReason: "This source type is not supported for inspection.",
  };
}

/** Project native configuration explicitly so backend metadata stays private. */
export async function getAlertRuleDetails(
  api: SentryApiService,
  organizationSlug: string,
  rule: IssueAlertRule,
  scopedProjectSlug?: string | null,
): Promise<AlertRuleDetails> {
  const scope = await api.getAlertRuleProjectScope({
    organizationSlug,
    ruleId: rule.id,
  });
  const project = scopedProjectSlug
    ? await api.getProject({
        organizationSlug,
        projectSlugOrId: scopedProjectSlug,
      })
    : undefined;
  const sources: AlertRuleDetails["sources"] = [];
  for (const id of rule.detectorIds ?? []) {
    try {
      const detector = await api.getDetector({
        organizationSlug,
        detectorId: id,
      });
      if (
        project &&
        detector.projectId !== null &&
        String(detector.projectId) !== String(project.id)
      ) {
        sources.push({ id: String(id), status: "outside_project_constraint" });
        continue;
      }
      sources.push({
        id: String(detector.id),
        status: "available",
        name: detector.name,
        type: detector.type,
        projectId:
          detector.projectId === null ? null : String(detector.projectId),
        enabled: detector.enabled,
        config: toDetectorConfig(detector.type, detector.config),
        conditionGroup: detector.conditionGroup
          ? conditionGroupSchema.parse(detector.conditionGroup)
          : null,
        dataSources: (detector.dataSources ?? []).map(sourceDetails),
      });
    } catch (error) {
      if (
        !(
          error instanceof ApiNotFoundError ||
          error instanceof ApiPermissionError
        )
      ) {
        throw error;
      }
      sources.push({
        id: String(id),
        status: "unavailable",
        reason: "Not found or not accessible.",
      });
    }
  }
  const projectIds = project
    ? scope.projectIds.filter((id) => id === String(project.id))
    : scope.projectIds;
  return {
    id: String(rule.id),
    name: rule.name,
    enabled: rule.enabled,
    config: z.object({ frequency: z.number().optional() }).parse(rule.config),
    environment: rule.environment,
    owner: rule.owner ? formatActor(rule.owner) : null,
    dateCreated: formatDate(rule.dateCreated),
    dateUpdated: formatDate(rule.dateUpdated),
    lastTriggered: formatDate(rule.lastTriggered),
    triggers: rule.triggers ? conditionGroupSchema.parse(rule.triggers) : null,
    actionFilters: (rule.actionFilters ?? []).map((group) =>
      actionGroupSchema.parse(group),
    ),
    scope: {
      includesAllProjects: scope.includesAllProjects,
      projectIds,
      ...(project
        ? {
            limitedToProject: scopedProjectSlug,
            ...(!scope.includesAllProjects
              ? {
                  outsideProjectCount:
                    scope.projectIds.length - projectIds.length,
                }
              : {}),
          }
        : {}),
    },
    sources,
    webUrl: api.getIssueAlertRuleUrl(organizationSlug, rule.id),
  };
}
