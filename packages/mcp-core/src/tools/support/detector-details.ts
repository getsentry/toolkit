import { z } from "zod";
import { isPlainObject } from "../../internal/type-guards";

export const conditionGroupSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  logicType: z.string(),
  conditions: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).optional(),
      type: z.string(),
      comparison: z.unknown(),
      conditionResult: z.unknown(),
    }),
  ),
});

const metricQuerySchema = z.object({
  dataset: z.string(),
  query: z.string(),
  aggregate: z.string(),
  timeWindow: z.number(),
  environment: z.string().nullable(),
  eventTypes: z.array(z.string()),
  extrapolationMode: z.string().nullable().optional(),
});

export const metricQueryDetailsSchema = metricQuerySchema
  .omit({ timeWindow: true })
  .extend({ timeWindowSeconds: z.number() });

/** Project the metric query without subscription or backend identifiers. */
export function getMetricQuery(source: Record<string, unknown>) {
  if (
    source.type !== "snuba_query_subscription" ||
    !isPlainObject(source.queryObj)
  ) {
    return null;
  }
  const parsed = metricQuerySchema.safeParse(source.queryObj.snubaQuery);
  if (!parsed.success) return null;
  const { timeWindow, ...query } = parsed.data;
  return { ...query, timeWindowSeconds: timeWindow };
}
