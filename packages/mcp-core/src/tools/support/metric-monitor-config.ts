import { z } from "zod";
import type { Detector, MetricMonitorUpdate } from "../../api-client/types";
import { UserInputError } from "../../errors";
import {
  conditionGroupSchema,
  getMetricQuery,
  metricQueryDetailsSchema,
} from "./detector-details";

const metricConditionSchema = conditionGroupSchema.shape.conditions.element;
const thresholdCondition = metricConditionSchema.extend({
  type: z.enum(["gt", "lt", "gte", "lte"]),
  comparison: z.number(),
  conditionResult: z.union([z.literal(75), z.literal(50), z.literal(0)]),
});
const anomalyCondition = metricConditionSchema.extend({
  type: z.literal("anomaly_detection"),
  comparison: z.object({
    sensitivity: z.enum(["low", "medium", "high"]),
    seasonality: z.literal("auto"),
    thresholdType: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  }),
  conditionResult: z.union([z.literal(75), z.literal(50)]),
});

const metricMonitorQuerySchema = metricQueryDetailsSchema.extend({
  dataset: z.enum([
    "events",
    "transactions",
    "generic_metrics",
    "metrics",
    "events_analytics_platform",
  ]),
  aggregate: z.string().min(1),
  timeWindowSeconds: z.number().int().positive(),
});

const metricMonitorDetectionConfigSchema = z.object({
  detectionType: z.enum(["static", "percent", "dynamic"]),
  comparisonDeltaSeconds: z.number().int().positive().nullable().optional(),
});

const metricMonitorConditionGroupSchema = conditionGroupSchema.extend({
  conditions: z
    .array(z.discriminatedUnion("type", [thresholdCondition, anomalyCondition]))
    .min(1)
    .max(3),
});

export const metricMonitorConfigFields = {
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  owner: z
    .string()
    .regex(/^(user|team):\d+$/)
    .nullable()
    .optional()
    .describe("Owner actor, e.g. team:123 or user:123. Pass null to clear."),
  query: metricMonitorQuerySchema
    .partial()
    .refine(
      (value) => Object.keys(value).length > 0,
      "Provide at least one query field.",
    )
    .optional()
    .describe(
      "Partial query changes. Omitted fields are preserved; environment:null clears its filter. metrics is crash-free Releases; events_analytics_platform supports spans, logs and application metrics via eventTypes. Dataset changes must include compatible aggregate and eventTypes.",
    ),
  config: metricMonitorDetectionConfigSchema
    .partial()
    .refine(
      (value) => Object.keys(value).length > 0,
      "Provide at least one config field.",
    )
    .optional()
    .describe(
      "Partial detection config. Percent mode requires comparisonDeltaSeconds. Selecting Static or Dynamic clears the comparison delta. Changing detectionType also requires compatible conditionGroup.",
    ),
  conditionGroup: metricMonitorConditionGroupSchema
    .optional()
    .describe(
      "Replaces ALL detection conditions; preserve existing IDs. Static/Percent use numeric comparisons, results 75 critical, 50 warning, 0 resolved, including a resolution condition. Percent 110 means 10% higher. Dynamic uses anomaly_detection with sensitivity, seasonality:auto and thresholdType 0 above, 1 below, 2 both.",
    ),
  workflowIds: z
    .array(z.string().regex(/^\d+$/))
    .optional()
    .describe(
      "Replaces this monitor's Alert connections. Copy all IDs to retain from get_metric_monitor_details; [] disconnects all. Does not edit the Alerts themselves.",
    ),
};

export const metricMonitorCreateFields = {
  name: metricMonitorConfigFields.name.unwrap(),
  description: metricMonitorConfigFields.description,
  owner: metricMonitorConfigFields.owner,
  query: metricMonitorQuerySchema
    .extend({
      environment: metricMonitorQuerySchema.shape.environment.default(null),
    })
    .describe(
      "Complete query: dataset, aggregate, filter, eventTypes and timeWindowSeconds. metrics is crash-free Releases; events_analytics_platform supports spans, logs and application metrics via eventTypes. Omitted environment means all environments.",
    ),
  config: metricMonitorDetectionConfigSchema.describe(
    "Detection mode. Percent requires comparisonDeltaSeconds. Static and Dynamic do not use a comparison delta.",
  ),
  conditionGroup: metricMonitorConditionGroupSchema
    .omit({ id: true })
    .extend({
      logicType: z.literal("any").default("any"),
      conditions: z
        .array(
          z.discriminatedUnion("type", [
            thresholdCondition.omit({ id: true }),
            anomalyCondition.omit({ id: true }),
          ]),
        )
        .min(1)
        .max(3),
    })
    .describe(
      "Complete conditions, using logicType any. Copied group and condition IDs are discarded. Static/Percent require thresholds and resolution (results 75 critical, 50 warning, 0 resolved). Percent 110 means 10% higher. Dynamic requires one anomaly_detection condition: sensitivity, seasonality:auto, thresholdType 0 above/1 below/2 both.",
    ),
  workflowIds: metricMonitorConfigFields.workflowIds
    .default([])
    .describe(
      "Existing notification Alert IDs to connect. Omit or pass [] to create without connected Alerts. Use find_alert_rules(kind='issue') to find workflow IDs.",
    ),
};

/** Convert partial tool input to the native detector write contract, preserving omitted fields. */
export function toMetricMonitorUpdate(
  current: Detector,
  params: z.infer<z.ZodObject<typeof metricMonitorConfigFields>>,
): MetricMonitorUpdate {
  const { status, query, config, conditionGroup, ...metadata } = params;
  const body: MetricMonitorUpdate = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  );
  if (status !== undefined) body.enabled = status === "active";
  if (query !== undefined) {
    const sources = current.dataSources ?? [];
    const existing = sources.length === 1 ? getMetricQuery(sources[0]) : null;
    if (!existing) {
      throw new UserInputError(
        "This monitor's query is unavailable or has multiple sources; cannot safely update it.",
      );
    }
    const { timeWindowSeconds, ...merged } = { ...existing, ...query };
    // GET nests the query in queryObj.snubaQuery; PUT accepts only the flat query fields.
    body.dataSources = [{ ...merged, timeWindow: timeWindowSeconds }];
  }
  if (config !== undefined || conditionGroup !== undefined) {
    if (
      config?.detectionType !== undefined &&
      config.detectionType !== current.config.detectionType &&
      !conditionGroup
    ) {
      throw new UserInputError(
        "Changing detectionType requires a compatible conditionGroup. Inspect get_metric_monitor_details first.",
      );
    }
    // Config replaces the stored object. Resending it also refreshes Seer for Dynamic condition changes.
    body.config = toMetricDetectionConfig(
      config ?? {},
      conditionGroup?.conditions ??
        conditionGroupSchema.parse(current.conditionGroup).conditions,
      current.config,
    );
    if (conditionGroup !== undefined) body.conditionGroup = conditionGroup;
  }
  if (Object.keys(body).length === 0) {
    throw new UserInputError(
      "Provide at least one field to update on the Metric Monitor.",
    );
  }
  return body;
}

/** Map detection config to native units and validate its effective conditions. */
export function toMetricDetectionConfig(
  config: Partial<z.infer<typeof metricMonitorDetectionConfigSchema>>,
  conditions: z.infer<typeof conditionGroupSchema>["conditions"],
  current: Detector["config"] = {},
): Detector["config"] {
  const { comparisonDeltaSeconds, ...changes } = config;
  const result: Detector["config"] = { ...current, ...changes };
  if (comparisonDeltaSeconds !== undefined)
    result.comparisonDelta = comparisonDeltaSeconds;
  if (result.detectionType !== "percent") {
    if (comparisonDeltaSeconds != null) {
      throw new UserInputError(
        "comparisonDeltaSeconds is only supported for Percent detection.",
      );
    }
    // A retained delta still enables percentage evaluation in the backend, regardless of detectionType.
    if (config.detectionType !== undefined) result.comparisonDelta = null;
  }
  const dynamic = result.detectionType === "dynamic";
  if (dynamic && conditions.length !== 1) {
    throw new UserInputError(
      "Dynamic detection requires exactly one anomaly_detection condition.",
    );
  }
  if (
    conditions.some(
      (condition) => (condition.type === "anomaly_detection") !== dynamic,
    )
  ) {
    throw new UserInputError(
      "conditionGroup must match detectionType: Dynamic requires anomaly_detection; Static and Percent require numeric threshold conditions.",
    );
  }
  if (
    result.detectionType === "percent" &&
    !(typeof result.comparisonDelta === "number" && result.comparisonDelta > 0)
  ) {
    throw new UserInputError(
      "Percent detection requires comparisonDeltaSeconds.",
    );
  }
  return result;
}
