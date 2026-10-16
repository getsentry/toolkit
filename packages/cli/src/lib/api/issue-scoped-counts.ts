/**
 * Scoped issue counts via the Sentry events endpoint.
 *
 * The issues-list endpoint's per-group seen-stats (`count`, `userCount`) honor
 * the `statsPeriod` but are NOT scoped to arbitrary query filters like
 * `release:` — they report period-wide totals across every value of the key.
 * The events endpoint, in contrast, returns counts that actually match the
 * filter. We re-query it per issue with `issue:<shortId>` AND the user's query
 * to replace the over-reported numbers. See getsentry/cli#1518.
 */

import pLimit from "p-limit";
import { logger } from "../logger.js";
import { queryEvents } from "./explore.js";
import { ORG_FANOUT_CONCURRENCY } from "./infrastructure.js";

const log = logger.withTag("issue-scoped-counts");

/** Filter-scoped event and affected-user counts for a single issue. */
export type ScopedCount = {
  count: number;
  userCount: number;
};

/** Time range + project scope shared by scoped-count queries. */
type ScopedCountTimeOptions = {
  statsPeriod?: string;
  start?: string;
  end?: string;
};

/**
 * Fetch filter-scoped event & user counts for a single issue via the events
 * endpoint. Returns `undefined` on any failure so the caller keeps the
 * (unscoped) list-endpoint numbers rather than breaking the listing.
 *
 * @param orgSlug - Organization slug
 * @param shortId - Issue short ID (scopes to the one group via `issue:`)
 * @param options - The user's query plus time range and optional project ID
 */
export async function fetchScopedCount(
  orgSlug: string,
  shortId: string,
  options: ScopedCountTimeOptions & {
    /** The user's --query (already sanitized). */
    query: string;
    /** Numeric project ID to scope the events query to. */
    projectId?: number;
  },
): Promise<ScopedCount | undefined> {
  const query = `issue:${shortId} ${options.query}`.trim();
  try {
    const response = await queryEvents(orgSlug, {
      fields: ["count()", "count_unique(user)"],
      dataset: "errors",
      query,
      statsPeriod: options.statsPeriod,
      start: options.start,
      end: options.end,
      project:
        options.projectId === undefined
          ? undefined
          : [String(options.projectId)],
      limit: 1,
    });
    const row = response.data.data[0];
    if (!row) {
      return;
    }
    return {
      count: Number(row["count()"] ?? 0),
      userCount: Number(row["count_unique(user)"] ?? 0),
    };
  } catch (error) {
    log.debug(`Scoped count refetch failed for ${shortId}: ${String(error)}`);
    return;
  }
}

/**
 * Fetch scoped counts for many issues in parallel (bounded concurrency),
 * returning a Map keyed by issue short ID. Issues whose refetch fails are
 * absent from the map so the caller keeps the unscoped fallback.
 */
export async function fetchScopedCounts(
  orgSlug: string,
  issues: { shortId: string; projectId?: number }[],
  options: ScopedCountTimeOptions & { query: string },
): Promise<Map<string, ScopedCount>> {
  const limit = pLimit(ORG_FANOUT_CONCURRENCY);
  const results = await Promise.all(
    issues.map((issue) =>
      limit(async () => {
        const scoped = await fetchScopedCount(orgSlug, issue.shortId, {
          query: options.query,
          statsPeriod: options.statsPeriod,
          start: options.start,
          end: options.end,
          projectId: issue.projectId,
        });
        return { shortId: issue.shortId, scoped };
      }),
    ),
  );

  const map = new Map<string, ScopedCount>();
  for (const { shortId, scoped } of results) {
    if (scoped) {
      map.set(shortId, scoped);
    }
  }
  return map;
}
