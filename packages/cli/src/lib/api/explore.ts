/**
 * Sentry Explore/Discover API — tabular and time-series event queries.
 *
 * Wraps the `events/` and `events-timeseries/` endpoints used by the Sentry
 * Explore UI, with user-specified aggregates, datasets, filters, and time ranges.
 */

import type { OrganizationEventsTimeseriesResponse } from "@sentry/api";

import type { EventsTableResponse } from "../../types/dashboard.js";
import { EventsTableResponseSchema } from "../../types/dashboard.js";
import { stringifyUnknown } from "../errors.js";
import { resolveOrgRegion } from "../region.js";
import {
  API_MAX_PER_PAGE,
  apiRequestToRegion,
  MAX_PAGINATION_PAGES,
  type PaginatedResponse,
  paginate,
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
   * Every Events dataset accepts it as long as the sort column is in
   * `fields`; resolve both with `resolveEventsSort` from
   * `@sentry/toolkit-core/events-sort`. A stable sort is required for correct
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

/** Options for an ungrouped time series, with project and environment filters in `query`. */
export type ExploreTimeSeriesQueryOptions = Pick<
  ExploreQueryOptions,
  "fields" | "dataset" | "query" | "statsPeriod" | "start" | "end"
> & {
  /** Bucket width as a duration, such as `5m`. Must be valid for the requested range. */
  interval: string;
};

type SdkTimeSeries = OrganizationEventsTimeseriesResponse["timeSeries"][number];

/**
 * The SDK response with the backend's string-valued aggregates preserved.
 * `max(timestamp)` returns an ISO date and `latest_event()` an event ID;
 * neither is represented by the SDK's numeric bucket type.
 */
export type EventsTimeSeriesResponse = Omit<
  OrganizationEventsTimeseriesResponse,
  "timeSeries"
> & {
  /** One series per aggregate, including bucket accuracy and completeness metadata. */
  timeSeries: (Omit<SdkTimeSeries, "values"> & {
    /** Buckets retain API timestamps in milliseconds and null values for missing data. */
    values: (Omit<SdkTimeSeries["values"][number], "value"> & {
      /** Aggregate result, without coercion of strings or missing values. */
      value: number | string | null;
    })[];
  })[];
};

/**
 * Query aggregate values over time without grouping or pagination.
 *
 * Uses the same regional transport as `queryEvents` because the generated
 * SDK input types do not support repeated `yAxis` or duration-string intervals.
 * Returns the complete API response, including sampling and ingestion metadata.
 */
export async function queryEventsTimeSeries(
  orgSlug: string,
  options: ExploreTimeSeriesQueryOptions,
): Promise<EventsTimeSeriesResponse> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const { data } = await apiRequestToRegion<EventsTimeSeriesResponse>(
    regionUrl,
    `/organizations/${orgSlug}/events-timeseries/`,
    {
      params: {
        dataset: options.dataset ?? "errors",
        yAxis: options.fields,
        query: options.query || undefined,
        interval: options.interval,
        statsPeriod:
          options.start || options.end
            ? undefined
            : (options.statsPeriod ?? "24h"),
        start: options.start,
        end: options.end,
      },
    },
  );
  return data;
}

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
  perPage: number,
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
    },
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
  },
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
      API_MAX_PER_PAGE,
    );

    allRows.push(...result.data.data);

    if (!result.nextCursor) {
      break;
    }
    cursor = result.nextCursor;
  }

  return allRows.map((row) => ({
    name: stringifyUnknown(row["metric.name"] ?? ""),
    type: stringifyUnknown(row["metric.type"] ?? "distribution"),
    unit: stringifyUnknown(row["metric.unit"] ?? "none"),
  }));
}

/**
 * Query the Explore/Events endpoint for aggregate or tabular event data.
 *
 * Calls `GET /organizations/{org}/events/` with the specified fields, dataset,
 * query, sort, and time range. Supports all standard Sentry Explore fields
 * including aggregates like `count()`, `count_unique(user)`, `p50(span.duration)`.
 *
 * Limits above one page are fetched with {@link paginate}. Meta is taken from
 * the first page — it is identical across pages.
 *
 * @param orgSlug - Organization slug
 * @param options - Query options
 * @returns Paginated response with tabular data and field metadata
 */
export async function queryEvents(
  orgSlug: string,
  options: ExploreQueryOptions,
): Promise<PaginatedResponse<EventsTableResponse>> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  let meta: EventsTableResponse["meta"];
  const { data, nextCursor } = await paginate(
    options,
    async (perPage, cursor) => {
      const page = await fetchEventsPage(
        regionUrl,
        orgSlug,
        { ...options, cursor },
        perPage,
      );
      // Meta is identical across pages; keep the first page's.
      meta ??= page.data.meta;
      return { data: page.data.data, nextCursor: page.nextCursor };
    },
    25,
  );
  return { data: { data, meta }, nextCursor };
}
