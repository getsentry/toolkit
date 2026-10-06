/**
 * Tracemetrics aggregate construction from simple metric names.
 *
 * Transforms user-friendly metric names (e.g., `llm.token_usage`) into the
 * four-part tracemetrics format required by the Sentry Events API when
 * querying `dataset=tracemetrics`: `aggregation(value,name,type,unit)`.
 */

import type { MetricMeta } from "./api/explore.js";
import { ResolutionError } from "./errors.js";
import { fuzzyMatch } from "./fuzzy.js";

/** Valid tracemetrics aggregation functions. */
const VALID_AGGS = new Set([
  "sum",
  "avg",
  "count",
  "min",
  "max",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "count_unique",
]);

/** Build a tracemetrics aggregate string from parts. */
export function makeTracemetricsAggregate(
  agg: string,
  name: string,
  type: string,
  unit: string
): string {
  return `${agg}(value,${name},${type},${unit})`;
}

/**
 * Resolve a simple metric name against discovered metadata and build
 * the tracemetrics aggregate field.
 *
 * @throws {ResolutionError} when the metric name isn't found
 */
export function resolveMetricField(
  metricName: string,
  agg: string,
  metrics: MetricMeta[]
): string {
  if (!VALID_AGGS.has(agg)) {
    throw new ResolutionError(
      `Aggregation '${agg}'`,
      `not recognized. Valid aggregations: ${[...VALID_AGGS].join(", ")}`,
      `sentry explore my-org/ -m ${metricName} --agg sum --dataset metrics`
    );
  }

  const match = metrics.find((m) => m.name === metricName);
  if (!match) {
    const candidateNames = Array.from(
      new Set(metrics.map((m) => m.name).filter((n) => n.length > 0))
    );
    const suggestions = fuzzyMatch(metricName, candidateNames, {
      maxResults: 5,
    });

    throw new ResolutionError(
      `Metric '${metricName}'`,
      "not found in this project",
      `sentry explore my-org/ -m ${metricName} --dataset metrics --period 7d`,
      suggestions.length > 0
        ? [`Similar metrics: ${suggestions.join(", ")}`]
        : ["Use a wider --period to search for older metrics"]
    );
  }

  return makeTracemetricsAggregate(agg, match.name, match.type, match.unit);
}
