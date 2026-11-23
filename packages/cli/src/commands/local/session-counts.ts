/**
 * Titles for `sessions` items: the per-status session counts that server SDKs
 * send in aggregate buckets.
 *
 * Browser-safe and dependency-free: `local event list` and the Local viewer
 * share it, so both show the same title for the same item.
 */

/** Statuses a bucket can count, in the order the title lists them. */
const SESSION_STATUSES = ["exited", "errored", "abnormal", "crashed"];

/** A `sessions` aggregate bucket: a `started` time and a count per status. */
function isSessionBucket(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The aggregate buckets of a `sessions` payload; empty for anything else. */
export function sessionAggregates(payload: unknown): Record<string, unknown>[] {
  const aggregates =
    typeof payload === "object" && payload !== null
      ? (payload as { aggregates?: unknown }).aggregates
      : undefined;
  return Array.isArray(aggregates) ? aggregates.filter(isSessionBucket) : [];
}

/**
 * Total each status across a `sessions` payload's buckets, as
 * `Session counts: 5 exited, 2 errored`. Returns undefined when no bucket
 * counts a session.
 */
export function sessionCountsTitle(payload: unknown): string | undefined {
  const counts = new Map<string, number>();
  for (const bucket of sessionAggregates(payload)) {
    for (const status of SESSION_STATUSES) {
      const count = bucket[status];
      if (typeof count === "number" && Number.isFinite(count) && count) {
        counts.set(status, (counts.get(status) ?? 0) + count);
      }
    }
  }
  return counts.size
    ? `Session counts: ${[...counts].map(([status, count]) => `${count} ${status}`).join(", ")}`
    : undefined;
}
