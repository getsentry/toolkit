import { z } from "zod";
import type { SentryApiService } from "../../api-client";
import type { Detector } from "../../api-client/types";
import { UserInputError } from "../../errors";
import {
  ParamOrganizationSlug,
  ParamProjectSlug,
  ParamRegionUrl,
} from "../../schema";
import { formatActor, formatDate } from "../catalog/support/api-formatting";
import {
  assertProjectConstraintEvidence,
  assertProjectRefWithinConstraint,
} from "../catalog/support/project-constraints";
import {
  conditionGroupSchema,
  getMetricQuery,
  metricQueryDetailsSchema,
} from "./detector-details";

export const metricMonitorReferenceFields = {
  organizationSlug: ParamOrganizationSlug,
  regionUrl: ParamRegionUrl.nullable().default(null),
  projectSlug: ParamProjectSlug.optional(),
  monitorId: z
    .string()
    .trim()
    .regex(/^\d+$/)
    .describe("Native Metric Monitor ID from find_metric_monitors."),
};

export const metricMonitorSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  projectId: z.string().nullable(),
  enabled: z.boolean(),
  owner: z.string().nullable(),
  workflowIds: z.array(z.string()),
  webUrl: z.string(),
});

export const metricMonitorDetailsSchema = metricMonitorSummarySchema.extend({
  description: z.string().nullable(),
  config: z.object({
    detectionType: z.string(),
    comparisonDeltaSeconds: z.number().optional(),
  }),
  conditionGroup: conditionGroupSchema
    .nullable()
    .describe(
      "Native detection conditions, including resolution. Results: 75 critical, 50 warning, 0 resolved. Percent comparisons are absolute percentages (110 means 10% higher). Dynamic comparisons contain sensitivity, seasonality and thresholdType.",
    ),
  dataSources: z.array(
    z.object({
      type: z.string(),
      query: metricQueryDetailsSchema.optional(),
      unavailableReason: z.string().optional(),
    }),
  ),
  dateCreated: z.string().nullable(),
  dateUpdated: z.string().nullable(),
});

export function toMetricMonitorSummary(
  api: SentryApiService,
  organizationSlug: string,
  detector: Detector,
) {
  return {
    id: detector.id,
    name: detector.name,
    projectId: detector.projectId,
    enabled: detector.enabled,
    owner: detector.owner ? formatActor(detector.owner) : null,
    workflowIds: detector.workflowIds ?? [],
    webUrl: api.getDetectorUrl(organizationSlug, detector.id),
  };
}

export function toMetricMonitorDetails(
  api: SentryApiService,
  organizationSlug: string,
  detector: Detector,
) {
  const config = z
    .object({
      detectionType: z.string(),
      comparisonDelta: z.number().nullish(),
    })
    .parse(detector.config);
  return {
    ...toMetricMonitorSummary(api, organizationSlug, detector),
    description: detector.description ?? null,
    config: {
      detectionType: config.detectionType,
      ...(config.comparisonDelta != null
        ? { comparisonDeltaSeconds: config.comparisonDelta }
        : {}),
    },
    conditionGroup: detector.conditionGroup
      ? conditionGroupSchema.parse(detector.conditionGroup)
      : null,
    dataSources: (detector.dataSources ?? []).map((source) => {
      const query = getMetricQuery(source);
      return {
        type: typeof source.type === "string" ? source.type : "unknown",
        ...(query
          ? { query }
          : { unavailableReason: "Source configuration is unavailable." }),
      };
    }),
    dateCreated: formatDate(detector.dateCreated),
    dateUpdated: formatDate(detector.dateUpdated),
  };
}

export function getMetricMonitorReference(detector: Detector): string {
  return detector.alertRuleId != null
    ? String(detector.alertRuleId)
    : `detector:${detector.id}`;
}

export async function listMetricMonitors(
  api: SentryApiService,
  params: {
    organizationSlug: string;
    projectSlug?: string;
    query?: string;
    cursor?: string;
    limit?: number;
  },
) {
  const project = params.projectSlug
    ? await api.getProject({
        organizationSlug: params.organizationSlug,
        projectSlugOrId: params.projectSlug,
      })
    : undefined;
  const page = await api.listDetectorsPage({
    organizationSlug: params.organizationSlug,
    projectId: project ? String(project.id) : undefined,
    types: ["metric_issue"],
    query: params.query,
    cursor: params.cursor,
    limit: params.limit,
  });
  return {
    ...page,
    detectors: page.detectors.filter(
      (detector) =>
        detector.type === "metric_issue" &&
        (!project || detector.projectId === String(project.id)),
    ),
  };
}

export async function getMetricMonitor(
  api: SentryApiService,
  params: {
    organizationSlug: string;
    monitorId: string;
    projectSlug?: string;
    scopedProjectSlug?: string | null;
  },
): Promise<Detector> {
  if (params.projectSlug) {
    assertProjectRefWithinConstraint({
      resourceLabel: "Metric Monitor",
      scopedProjectSlug: params.scopedProjectSlug,
      project: { slug: params.projectSlug },
    });
  }
  const projectSlug = params.scopedProjectSlug ?? params.projectSlug;
  const detector = await api.getDetector({
    organizationSlug: params.organizationSlug,
    detectorId: params.monitorId,
  });
  if (detector.type !== "metric_issue") {
    throw new UserInputError(
      "This ID does not identify a Metric Monitor. Use find_metric_monitors to find its monitor ID.",
    );
  }
  if (projectSlug) {
    const project = await api.getProject({
      organizationSlug: params.organizationSlug,
      projectSlugOrId: projectSlug,
    });
    assertProjectConstraintEvidence({
      resourceLabel: "Metric Monitor",
      scopedProjectSlug: projectSlug,
      hasEvidence: detector.projectId === String(project.id),
    });
  }
  return detector;
}

export async function findExactMetricMonitorMatches(
  api: SentryApiService,
  params: { organizationSlug: string; projectSlug?: string; name: string },
) {
  const page = await listMetricMonitors(api, {
    ...params,
    query: `name:${JSON.stringify(params.name)}`,
    limit: 100,
  });
  if (page.nextCursor) {
    throw new UserInputError(
      "Metric Monitor name search is incomplete. Use find_metric_monitors and retry with get_metric_monitor_details and its monitor ID.",
    );
  }
  return page.detectors.filter(
    (detector) => detector.name.toLowerCase() === params.name.toLowerCase(),
  );
}
