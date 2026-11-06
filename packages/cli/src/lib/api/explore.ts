/**
 * Sentry Explore/Discover API — tabular and time-series event queries.
 *
 * Wraps the `events/` and `events-timeseries/` endpoints used by the Sentry
 * Explore UI, with user-specified aggregates, datasets, filters, and time ranges,
 * and `trace-items/metrics/`, which lists the metrics an org has.
 */

import {
  type ListOrganizationTraceMetricsData,
  type ListOrganizationTraceMetricsResponse2,
  listOrganizationTraceMetrics,
  type OrganizationEventsTimeseriesResponse,
} from "@sentry/api";

import type { EventsTableResponse } from "../../types/dashboard.js";
import { EventsTableResponseSchema } from "../../types/dashboard.js";
import { resolveOrgRegion } from "../region.js";
import {
  apiRequestToRegion,
  getOrgSdkConfig,
  MAX_PAGINATION_PAGES,
  type PaginatedResponse,
  paginate,
  parseLinkHeader,
  unwrapPaginatedResult,
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
   * Numeric project ID, sent as the `project` param. `project:<slug>` in
   * `query` only matches projects the requester is a member of, so a valid
   * slug can 400 with "not actively selected" (#1317).
   */
  projectId?: number;
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

/** Options for an ungrouped time series, with environment filters in `query`. */
export type ExploreTimeSeriesQueryOptions = Pick<
  ExploreQueryOptions,
  "fields" | "dataset" | "query" | "projectId" | "statsPeriod" | "start" | "end"
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
        project: options.projectId,
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
        project: options.projectId,
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

/** A trace metric returned by {@link listTraceMetrics}. */
export type TraceMetric = ListOrganizationTraceMetricsResponse2[number];

/** Sort accepted by {@link listTraceMetrics}. */
export type TraceMetricSort = NonNullable<
  NonNullable<ListOrganizationTraceMetricsData["query"]>["sort"]
>;

/** Most metrics the trace metrics endpoint returns per page. */
const TRACE_METRICS_MAX_PER_PAGE = 1000;

/** Options for {@link listTraceMetrics}. */
export type ListTraceMetricsOptions = {
  /** Project IDs or slugs to scope to (omit for all accessible projects) */
  project?: Array<number | string>;
  /** Environment names to scope to */
  environment?: string[];
  /** Search query, in the metrics dataset's syntax */
  query?: string;
  /** Response field to sort by, `-` prefixed for descending (default: name) */
  sort?: TraceMetricSort;
  /** Relative time window, e.g. "7d" (overrides start/end) */
  statsPeriod?: string;
  /** Absolute window start (ISO-8601) */
  start?: string;
  /** Absolute window end (ISO-8601) */
  end?: string;
  /** Page size, sent as `per_page` (at most {@link TRACE_METRICS_MAX_PER_PAGE}) */
  perPage?: number;
  /** Pagination cursor from a previous page's `nextCursor` */
  cursor?: string;
};

/**
 * List the trace metrics of an org, one row per name/type/unit, via
 * `GET /organizations/{org}/trace-items/metrics/`.
 *
 * The response also seeds `--metric` completion (`api/completion-seed.ts`).
 *
 * @param orgSlug - Organization slug
 * @param options - Project, environment, query, sort, time, and page options
 * @returns One page of metrics and an optional next-page cursor
 */
export async function listTraceMetrics(
  orgSlug: string,
  options: ListTraceMetricsOptions = {},
): Promise<PaginatedResponse<TraceMetric[]>> {
  const config = await getOrgSdkConfig(orgSlug);
  // `per_page` and `cursor` are accepted by the endpoint's paginator but
  // missing from the SDK's generated query type.
  const query: NonNullable<ListOrganizationTraceMetricsData["query"]> & {
    per_page?: number;
    cursor?: string;
  } = {
    project: options.project?.length ? options.project : undefined,
    environment: options.environment?.length ? options.environment : undefined,
    query: options.query || undefined,
    sort: options.sort,
    statsPeriod: options.statsPeriod,
    start: options.start,
    end: options.end,
    per_page: options.perPage,
    cursor: options.cursor,
  };
  const result = await listOrganizationTraceMetrics({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query,
  });
  return unwrapPaginatedResult<TraceMetric[]>(
    result,
    "Failed to list trace metrics",
  );
}

/** Metric metadata returned by {@link queryMetricsMeta}. */
export type MetricMeta = {
  name: string;
  type: string;
  unit: string;
};

/**
 * Discover the metrics of an org for resolving `--metric`, with
 * {@link listTraceMetrics}.
 *
 * Follows every page (bounded by {@link MAX_PAGINATION_PAGES}); the
 * endpoint returns up to {@link TRACE_METRICS_MAX_PER_PAGE} metrics per
 * page, so one request usually covers an org.
 */
export async function queryMetricsMeta(
  orgSlug: string,
  options?: {
    statsPeriod?: string;
    start?: string;
    end?: string;
    project?: string;
    /** Numeric ID for `project`, sent instead of the slug when known */
    projectId?: number;
  },
): Promise<MetricMeta[]> {
  const project = options?.projectId ?? options?.project;
  const baseOptions: ListTraceMetricsOptions = {
    project: project === undefined ? undefined : [project],
    statsPeriod:
      options?.start || options?.end
        ? undefined
        : (options?.statsPeriod ?? "7d"),
    start: options?.start,
    end: options?.end,
    perPage: TRACE_METRICS_MAX_PER_PAGE,
  };

  const metrics: TraceMetric[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGINATION_PAGES; page += 1) {
    const result = await listTraceMetrics(orgSlug, { ...baseOptions, cursor });
    metrics.push(...result.data);
    if (!result.nextCursor) {
      break;
    }
    cursor = result.nextCursor;
  }

  return metrics.map((metric) => ({
    name: metric.name,
    type: metric.type,
    unit: metric.unit ?? "none",
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
