import {
  METRIC_MONITOR_DATASETS,
  METRIC_MONITOR_PRIORITY,
  METRIC_MONITOR_THRESHOLD_TYPES,
} from "@sentry/toolkit-core/metric-monitor";
import { z } from "zod";
import type { Detector, MetricMonitorUpdate } from "../../api-client/types";
import { UserInputError } from "../../errors";
import {
  conditionGroupSchema,
  getMetricQuery,
  metricQueryDetailsSchema,
} from "./detector-details";

const metricConditionSchema = conditionGroupSchema.shape.conditions.element;
const { critical, warning, resolved } = METRIC_MONITOR_PRIORITY;
const thresholdCondition = metricConditionSchema.extend({
  type: z.enum(METRIC_MONITOR_THRESHOLD_TYPES),
  comparison: z
    .number()
    .describe(
      "Threshold value. For Percent detection it is an absolute percentage of the earlier window: 110 means 10% higher.",
    ),
  conditionResult: z
    .literal([critical, warning, resolved])
    .describe("75 critical, 50 warning, 0 resolved."),
});
const anomalyCondition = metricConditionSchema.extend({
  type: z.literal("anomaly_detection"),
  comparison: z.object({
    sensitivity: z.enum(["low", "medium", "high"]),
    seasonality: z.literal("auto"),
    thresholdType: z
      .literal([0, 1, 2])
      .describe("0 above, 1 below, 2 above or below."),
  }),
  conditionResult: z.literal([critical, warning]),
});

const metricMonitorQuerySchema = metricQueryDetailsSchema.extend({
  dataset: z
    .enum(METRIC_MONITOR_DATASETS)
    .describe(
      "`metrics` is crash-free releases. `events_analytics_platform` covers spans, logs, and application metrics, chosen by eventTypes.",
    ),
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
    .describe("Owner as user:<id> or team:<id>. Null clears it."),
  query: metricMonitorQuerySchema
    .partial()
    .refine(
      (value) => Object.keys(value).length > 0,
      "Provide at least one query field.",
    )
    .optional()
    .describe(
      "Query fields to change; omitted fields are kept and a null environment clears the filter. A new dataset needs a matching aggregate and eventTypes.",
    ),
  config: metricMonitorDetectionConfigSchema
    .partial()
    .refine(
      (value) => Object.keys(value).length > 0,
      "Provide at least one config field.",
    )
    .optional()
    .describe(
      "Detection config fields to change. Static and Dynamic clear the comparison delta; a new detection type needs a matching condition group.",
    ),
  conditionGroup: metricMonitorConditionGroupSchema
    .optional()
    .describe(
      "Replaces all detection conditions; keep existing IDs. Static and Percent use threshold conditions, including a resolved one. Dynamic uses one anomaly_detection condition.",
    ),
  workflowIds: z
    .array(z.string().regex(/^\d+$/))
    .optional()
    .describe(
      "Alert workflow IDs to connect; replaces the current list. Copy IDs to keep from get_metric_monitor_details; [] disconnects all. The Alerts are not edited.",
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
    .describe("Complete metric query. Omit environment for all environments."),
  config: metricMonitorDetectionConfigSchema.describe(
    "Detection mode: Static thresholds, Percent change against an earlier window (needs comparisonDeltaSeconds), or Dynamic anomaly detection (needs enough history).",
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
      "Complete detection conditions; copied IDs are dropped. Static and Percent use threshold conditions, including a resolved one. Dynamic uses one anomaly_detection condition.",
    ),
  workflowIds: metricMonitorConfigFields.workflowIds
    .default([])
    .describe(
      "Alert workflow IDs to connect, from find_alert_rules with `issue`. Omit to create with no Alerts.",
    ),
};

/** Convert partial tool input to the native detector write contract, preserving omitted fields. */
export function toMetricMonitorUpdate(
  current: Detector,
  params: z.infer<z.ZodObject<typeof metricMonitorConfigFields>>,
): MetricMonitorUpdate {
  const { status, query, config, conditionGroup, ...metadata } = params;
  const body: MetricMonitorUpdate = Object.fromEntries(
    Object.entries<unknown>(metadata).filter(
      ([, value]) => value !== undefined,
    ),
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
