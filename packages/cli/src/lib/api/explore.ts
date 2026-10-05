/**
 * Sentry Explore/Discover API — aggregate event queries.
 *
 * Wraps `GET /organizations/{org}/events/` with user-specified fields, dataset,
 * query, sort, and time range. This is the same endpoint used by the Sentry
 * Explore UI for arbitrary event queries with aggregation support.
 */

import type { EventsTableResponse } from "../../types/dashboard.js";
import { EventsTableResponseSchema } from "../../types/dashboard.js";
import { resolveOrgRegion } from "../region.js";
import {
  API_MAX_PER_PAGE,
  apiRequestToRegion,
  MAX_PAGINATION_PAGES,
  type PaginatedResponse,
  parseLinkHeader,
} from "./infrastructure.js";

/** Options for querying the Explore/Events endpoint. */
export type ExploreQueryOptions = {
  /** Fields to request — columns, aggregates, or equations */
  fields: string[];
  /** Dataset to query: errors, spans, tracemetrics, logs, replays */
  dataset?: string;
  /** Sentry search query filter */
  query?: string;
  /**
   * Sort field. Prefix with `-` for descending.
   * Supported on the `spans`, `errors`, and `discover` datasets; `metrics` and
   * `logs` reject it with 400. A stable sort is required for correct
   * offset-based cursor pagination on grouped aggregate queries (#1519).
   */
  sort?: string;
  /** Maximum number of rows to return */
  limit?: number;
  /** Pagination cursor */
  cursor?: string;
  /** Relative time period (e.g., "24h", "7d"). Mutually exclusive with start/end. */
  statsPeriod?: string;
  /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  start?: string;
  /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  end?: string;
};

/**
 * Fetch a single page of events from the Explore/Events endpoint.
 *
 * Internal helper used by {@link queryEvents} for both single-page and
 * multi-page (auto-paginating) fetches.
 *
 * @param regionUrl - Resolved region base URL
 * @param orgSlug - Organization slug
 * @param options - Query options
 * @param perPage - Number of rows to request per page
 * @returns Paginated response with tabular data and field metadata
 */
async function fetchEventsPage(
  regionUrl: string,
  orgSlug: string,
  options: ExploreQueryOptions,
  perPage: number
): Promise<PaginatedResponse<EventsTableResponse>> {
  const { data, headers } = await apiRequestToRegion<EventsTableResponse>(
    regionUrl,
    `/organizations/${orgSlug}/events/`,
    {
      params: {
        dataset: options.dataset ?? "errors",
        field: options.fields,
        query: options.query || undefined,
        sort: options.sort || undefined,
        per_page: perPage,
        statsPeriod:
          options.start || options.end
            ? undefined
            : (options.statsPeriod ?? "24h"),
        start: options.start,
        end: options.end,
        cursor: options.cursor,
      },
      schema: EventsTableResponseSchema,
    }
  );

  const { nextCursor } = parseLinkHeader(headers.get("link") ?? null);
  return { data, nextCursor };
}

/** Metric metadata returned by {@link queryMetricsMeta}. */
export type MetricMeta = {
  name: string;
  type: string;
  unit: string;
};

/**
 * Discover available metrics for an org via the Events API.
 *
 * Queries `dataset=tracemetrics` with meta-fields (`metric.name`, etc.)
 * — the same technique the Sentry Explore Metrics UI uses.
 *
 * Auto-paginates to collect all available metrics (bounded by
 * {@link MAX_PAGINATION_PAGES} to prevent runaway loops).
 */
export async function queryMetricsMeta(
  orgSlug: string,
  options?: {
    statsPeriod?: string;
    start?: string;
    end?: string;
    project?: string;
  }
): Promise<MetricMeta[]> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const query = options?.project ? `project:${options.project}` : undefined;

  const baseOptions: ExploreQueryOptions = {
    fields: ["metric.name", "metric.type", "metric.unit"],
    dataset: "tracemetrics",
    query,
    statsPeriod:
      options?.start || options?.end
        ? undefined
        : (options?.statsPeriod ?? "7d"),
    start: options?.start,
    end: options?.end,
  };

  const allRows: Record<string, unknown>[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const result = await fetchEventsPage(
      regionUrl,
      orgSlug,
      { ...baseOptions, cursor },
      API_MAX_PER_PAGE
    );

    allRows.push(...result.data.data);

    if (!result.nextCursor) {
      break;
    }
    cursor = result.nextCursor;
  }

  return allRows.map((row) => ({
    name: String(row["metric.name"] ?? ""),
    type: String(row["metric.type"] ?? "distribution"),
    unit: String(row["metric.unit"] ?? "none"),
  }));
}

/**
 * Query the Explore/Events endpoint for aggregate or tabular event data.
 *
 * Calls `GET /organizations/{org}/events/` with the specified fields, dataset,
 * query, sort, and time range. Supports all standard Sentry Explore fields
 * including aggregates like `count()`, `count_unique(user)`, `p50(span.duration)`.
 *
 * When `limit` exceeds {@link API_MAX_PER_PAGE}, transparently fetches multiple
 * pages using cursor-based pagination (bounded by {@link MAX_PAGINATION_PAGES}).
 * Meta is taken from the first page — it is identical across pages.
 *
 * @param orgSlug - Organization slug
 * @param options - Query options
 * @returns Paginated response with tabular data and field metadata
 */
export async function queryEvents(
  orgSlug: string,
  options: ExploreQueryOptions
): Promise<PaginatedResponse<EventsTableResponse>> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const limit = options.limit ?? 25;
  const perPage = Math.min(limit, API_MAX_PER_PAGE);

  // Fast path: single-page fetch when limit fits in one API page
  if (limit <= API_MAX_PER_PAGE) {
    return fetchEventsPage(regionUrl, orgSlug, options, perPage);
  }

  // Multi-page: accumulate rows across pages up to the requested limit
  const allRows: Record<string, unknown>[] = [];
  let meta: EventsTableResponse["meta"] | undefined;
  let cursor: string | undefined = options.cursor;

  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const result = await fetchEventsPage(
      regionUrl,
      orgSlug,
      { ...options, cursor },
      perPage
    );

    if (page === 0) {
      meta = result.data.meta;
    }

    allRows.push(...result.data.data);

    // Stop when we've reached the requested limit or there are no more pages
    if (allRows.length >= limit || !result.nextCursor) {
      // Overshot — trim and drop nextCursor (cursor would skip items)
      if (allRows.length > limit) {
        return {
          data: { data: allRows.slice(0, limit), meta },
        };
      }
      return {
        data: { data: allRows, meta },
        nextCursor: result.nextCursor,
      };
    }

    cursor = result.nextCursor;
  }

  // Safety limit reached — return what we have, no nextCursor
  return {
    data: { data: allRows.slice(0, limit), meta },
  };
}
