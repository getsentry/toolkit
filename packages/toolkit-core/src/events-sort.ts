/**
 * Sort resolution for the Sentry Events (`/events/`) and Events Stats
 * (`/events-stats/`) endpoints, shared by the CLI and MCP.
 *
 * Every Events dataset honors `sort` (errors, spans, logs, tracemetrics, ...).
 * The only constraint Sentry enforces is that the sort column must also be
 * selected: RPC datasets reply "orderby must also be in the selected columns
 * or groupby", and the errors `events-stats` top-events path replies "Cannot
 * sort by a field that is not selected." Both surface as a 400, which is easy
 * to misread as "this dataset does not support sort".
 *
 * Sending a sort matters beyond ordering. The events cursor is offset-based,
 * so grouped aggregate queries without a stable order overlap and skip rows
 * across pages. That causes duplicate rows, a total that drifts between runs,
 * and a `--limit` that returns an arbitrary subset instead of a top N.
 */

/** Return the column a sort expression orders by, without the `-` prefix. */
export function getSortField(sort: string): string {
  return sort.startsWith("-") ? sort.slice(1) : sort;
}

/** Whether an Events field is an aggregate function such as `count()`. */
export function isAggregateField(field: string): boolean {
  return field.includes("(") && field.includes(")");
}

/**
 * Add the sort column to the selected fields when Sentry would otherwise
 * reject the request.
 *
 * A non-aggregate sort column is not added to an aggregate query: that would
 * change its GROUP BY and silently corrupt the result. Sentry's 400 is the
 * better outcome there, so the caller can fix the request explicitly.
 */
export function ensureSortInFields(
  fields: readonly string[],
  sort: string | undefined,
): string[] {
  const sortField = sort ? getSortField(sort.trim()) : "";
  if (
    sortField &&
    !fields.includes(sortField) &&
    (isAggregateField(sortField) || !fields.some(isAggregateField))
  ) {
    return [...fields, sortField];
  }
  return [...fields];
}

/** Resolved `field` and `sort` params for an Events request. */
export type ResolvedEventsSort = {
  fields: string[];
  sort: string | undefined;
};

/**
 * Pick the sort for an Events request and make sure its column is selected.
 *
 * An explicit sort wins. Otherwise grouped aggregate queries sort by their
 * first aggregate descending, which gives cursor pagination a stable order
 * and makes `limit` a top N. Non-aggregate queries without an explicit sort
 * keep the endpoint default.
 */
export function resolveEventsSort({
  fields,
  sort,
}: {
  fields: readonly string[];
  sort?: string | null;
}): ResolvedEventsSort {
  const explicitSort = sort?.trim() || undefined;
  const firstAggregate = fields.find(isAggregateField);
  const resolvedSort =
    explicitSort ?? (firstAggregate ? `-${firstAggregate}` : undefined);
  return {
    fields: ensureSortInFields(fields, resolvedSort),
    sort: resolvedSort,
  };
}
