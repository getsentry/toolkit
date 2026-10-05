import { z } from "zod";
import type { SentryApiService } from "../../api-client";
import { ApiNotFoundError, ApiPermissionError } from "../../api-client";
import type { IssueAlertRule } from "../../api-client/types";
import { isPlainObject } from "../../internal/type-guards";
import { formatActor, formatDate } from "../catalog/support/api-formatting";
import { conditionGroupSchema, getMetricQuery } from "./detector-details";

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

function sourceDetails(source: Record<string, unknown>) {
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
) {
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
  const sources = [];
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
        config: detector.type === "issue_stream" ? {} : detector.config,
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
