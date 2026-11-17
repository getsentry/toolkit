/**
 * Saved dashboard widget transformations shared by the CLI and MCP.
 *
 * Sentry stores a widget query's transformations as ordered string lists
 * keyed by the aggregate's position (`{"0": ["fill(linear)"]}`), and the
 * dashboard details endpoint always returns the map (`{}` when none are
 * saved). Servers that predate the field omit it. See
 * `DashboardWidgetQueryResponse.transformations` in
 * `src/sentry/api/serializers/models/dashboard.py` and
 * `DashboardWidgetQuerySerializer.validate_transformations` in
 * `src/sentry/api/serializers/rest_framework/dashboard.py`.
 */

/** Ordered transformations saved for one aggregate position. */
export type SavedAggregateTransformations = {
  /** Zero-based aggregate position; the key Sentry stores. */
  aggregateIndex: number;
  /** Aggregate at that position, or null when the query has none there. */
  aggregate: string | null;
  /** Saved transformations, verbatim and in application order. */
  transformations: string[];
  /** Human-readable description of the aggregate and its transformations. */
  description: string;
};

// Sentry rejects any other key, so only canonical indexes can be saved.
const AGGREGATE_INDEX = /^(0|[1-9]\d*)$/;

/**
 * Lists a query's saved transformations by aggregate position.
 *
 * Every saved position is kept, including empty lists and positions without
 * an aggregate, so duplicate aggregates stay distinguishable by index.
 *
 * @returns Entries sorted by aggregate position; `null` when the server did
 *   not report transformations; `undefined` when none are saved.
 */
export function listSavedAggregateTransformations(
  aggregates: readonly string[],
  transformations: Readonly<Record<string, readonly string[]>> | undefined,
): SavedAggregateTransformations[] | null | undefined {
  if (transformations === undefined) {
    return null;
  }
  const entries = Object.entries(transformations)
    .filter(([key]) => AGGREGATE_INDEX.test(key))
    .map(([key, steps]) => {
      const aggregateIndex = Number(key);
      const aggregate = aggregates[aggregateIndex] ?? null;
      return {
        aggregateIndex,
        aggregate,
        transformations: [...steps],
        description: describeAggregateTransformations(
          aggregateIndex,
          aggregate,
          steps,
        ),
      };
    })
    .sort((a, b) => a.aggregateIndex - b.aggregateIndex);
  return entries.length > 0 ? entries : undefined;
}

/**
 * Describes one aggregate's saved transformations, for example
 * `count() (aggregate 2): fill(linear) → smooth(ema,7,0.25)`.
 * Positions are one-based here so they match what people count.
 */
function describeAggregateTransformations(
  aggregateIndex: number,
  aggregate: string | null,
  transformations: readonly string[],
): string {
  const position = `aggregate ${aggregateIndex + 1}`;
  const target =
    aggregate === null
      ? `${position} (no aggregate)`
      : `${aggregate} (${position})`;
  const steps =
    transformations.length > 0 ? transformations.join(" → ") : "none";
  return `${target}: ${steps}`;
}
