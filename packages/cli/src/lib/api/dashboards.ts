/**
 * Dashboard API functions
 *
 * CRUD operations for Sentry dashboards, plus widget data
 * query functions for rendering dashboard widgets with actual data.
 */

import {
  createOrganizationDashboard,
  getOrganizationDashboard,
  listOrganizationDashboardRevisions,
  listOrganizationDashboards,
  type ListOrganizationEventsTimeseriesData,
  listOrganizationEvents,
  listOrganizationEventsTimeseries,
  restoreOrganizationDashboardRevision,
  updateOrganizationDashboard,
} from "@sentry/api";
import { resolveEventsSort } from "@sentry/toolkit-core/events-sort";

import { array } from "valibot";

import {
  type DashboardDetail,
  DashboardDetailSchema,
  type DashboardListItem,
  type DashboardRevision,
  DashboardRevisionSchema,
  type DashboardWidget,
  type ErrorResult,
  EventsTableResponseSchema,
  type EventsTimeseriesResponse,
  EventsTimeseriesResponseSchema,
  type EventsTimeseriesSeries,
  mapWidgetTypeToDataset,
  type ScalarResult,
  TABLE_DISPLAY_TYPES,
  type TableResult,
  type TextResult,
  TIMESERIES_DISPLAY_TYPES,
  type TimeseriesResult,
  type WidgetDataResult,
} from "../../types/dashboard.js";
import type { EventsDataset } from "../datasets.js";
import { reportCliError } from "../error-reporting.js";
import { ApiError, stringifyUnknown } from "../errors.js";

import { getSdkClientConfig } from "../sentry-sdk-client.js";

import {
  getOrgSdkConfig,
  ORG_FANOUT_CONCURRENCY,
  type PaginatedResponse,
  unwrapPaginatedResult,
  unwrapResult,
  unwrapValidatedResult,
  validateResponse,
} from "./infrastructure.js";

/**
 * List dashboards in an organization with cursor-based pagination.
 *
 * Returns both the dashboard list items and pagination metadata so callers
 * can iterate through pages. Use `cursor` to resume from a previous page.
 *
 * @param orgSlug - Organization slug
 * @param options - Pagination parameters (perPage, cursor)
 * @returns Paginated response with dashboard list items and optional next cursor
 */
export async function listDashboardsPaginated(
  orgSlug: string,
  options: { perPage?: number; cursor?: string } = {},
): Promise<PaginatedResponse<DashboardListItem[]>> {
  const config = getOrgSdkConfig();

  const result = await listOrganizationDashboards({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query: { per_page: options.perPage, cursor: options.cursor },
  });

  return unwrapPaginatedResult<DashboardListItem[]>(
    result,
    "Failed to list dashboards",
  );
}

/**
 * Get a dashboard by ID.
 *
 * @param orgSlug - Organization slug
 * @param dashboardId - Dashboard ID
 * @returns Full dashboard detail with widgets
 */
export async function getDashboard(
  orgSlug: string,
  dashboardId: string,
): Promise<DashboardDetail> {
  const config = getOrgSdkConfig();

  const result = await getOrganizationDashboard({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      dashboard_id: dashboardId as unknown as number,
    },
  });

  return unwrapResult<DashboardDetail>(
    result,
    `Failed to get dashboard '${dashboardId}'`,
  );
}

/**
 * Create a new dashboard.
 *
 * @param orgSlug - Organization slug
 * @param body - Dashboard creation body (title, optional widgets)
 * @returns Created dashboard detail
 */
export async function createDashboard(
  orgSlug: string,
  body: { title: string; widgets?: DashboardWidget[]; projects?: number[] },
): Promise<DashboardDetail> {
  const config = getOrgSdkConfig();

  const result = await createOrganizationDashboard({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    body: body as unknown as Parameters<
      typeof createOrganizationDashboard
    >[0]["body"],
  });

  return unwrapResult<DashboardDetail>(result, "Failed to create dashboard");
}

/**
 * Update a dashboard (full PUT — replaces all widgets).
 * Always GET first, modify, then PUT the full widget list.
 *
 * @param orgSlug - Organization slug
 * @param dashboardId - Dashboard ID
 * @param body - Dashboard update body (title, widgets)
 * @returns Updated dashboard detail
 */
export async function updateDashboard(
  orgSlug: string,
  dashboardId: string,
  body: {
    title: string;
    widgets: DashboardWidget[];
    projects?: number[];
    environment?: string[];
    period?: string | null;
  },
): Promise<DashboardDetail> {
  const config = getOrgSdkConfig();

  const result = await updateOrganizationDashboard({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      dashboard_id: dashboardId as unknown as number,
    },
    body: body as unknown as Parameters<
      typeof updateOrganizationDashboard
    >[0]["body"],
  });

  return unwrapResult<DashboardDetail>(
    result,
    `Failed to update dashboard '${dashboardId}'`,
  );
}

// ---------------------------------------------------------------------------
// Revision history
// ---------------------------------------------------------------------------

/**
 * List revisions for a dashboard with cursor-based pagination.
 *
 * @param orgSlug - Organization slug
 * @param dashboardId - Dashboard ID
 * @param options - Pagination parameters (perPage, cursor)
 * @returns Paginated response with dashboard revisions
 */
export async function listDashboardRevisionsPaginated(
  orgSlug: string,
  dashboardId: string,
  options: { perPage?: number; cursor?: string } = {},
): Promise<PaginatedResponse<DashboardRevision[]>> {
  const config = getOrgSdkConfig();
  const result = await listOrganizationDashboardRevisions({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      dashboard_id: dashboardId as unknown as number,
    },
    query: { per_page: options.perPage, cursor: options.cursor },
  });
  const { response, ...page } = unwrapPaginatedResult<unknown>(
    result,
    `Failed to list revisions for dashboard '${dashboardId}'`,
  );
  const data = validateResponse(
    array(DashboardRevisionSchema),
    page.data,
    `/organizations/${orgSlug}/dashboards/${dashboardId}/revisions/`,
    response?.status ?? 0,
  );
  return { ...page, data };
}

/**
 * Restore a dashboard to a specific revision.
 *
 * @param orgSlug - Organization slug
 * @param dashboardId - Dashboard ID
 * @param revisionId - Revision ID to restore
 * @returns The restored dashboard detail
 */
export async function restoreDashboardRevision(
  orgSlug: string,
  dashboardId: string,
  revisionId: string,
): Promise<DashboardDetail> {
  const config = getOrgSdkConfig();
  const result = await restoreOrganizationDashboardRevision({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      dashboard_id: dashboardId as unknown as number,
      revision_id: revisionId as unknown as number,
    },
  });
  return unwrapValidatedResult(
    result,
    `Failed to restore revision '${revisionId}' of dashboard '${dashboardId}'`,
    DashboardDetailSchema,
    `/organizations/${orgSlug}/dashboards/${dashboardId}/revisions/${revisionId}/restore/`,
  );
}

// ---------------------------------------------------------------------------
// Widget data queries
// ---------------------------------------------------------------------------

/** Options for querying widget data */
type WidgetQueryOptions = {
  /** Override the dashboard's time period (e.g., "24h", "7d") */
  period?: string;
  /** Absolute start datetime (ISO-8601). Mutually exclusive with period. */
  start?: string;
  /** Absolute end datetime (ISO-8601). Mutually exclusive with period. */
  end?: string;
  /** Pre-computed total seconds for interval computation (for absolute ranges). */
  periodSeconds?: number;
  /** Filter by environment(s) — from dashboard.environment */
  environment?: string[];
  /** Filter by project ID(s) — from dashboard.projects */
  project?: number[];
};

// ---------------------------------------------------------------------------
// Optimal interval computation
// ---------------------------------------------------------------------------

/** Sentry dashboard grid columns (must match formatter GRID_COLS). */
const GRID_COLS = 6;

/** Overhead subtracted from widget column width to get chart area. */
const CHART_WIDTH_OVERHEAD = 12;

/** Minimum terminal width — mirrors formatter MIN_TERM_WIDTH. */
const MIN_TERM_WIDTH = 80;

/** Fallback terminal width for non-TTY — mirrors formatter DEFAULT_TERM_WIDTH. */
const DEFAULT_TERM_WIDTH = 100;

const PERIOD_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
};

const PERIOD_RE = /^(\d+)([smhdw])$/;

/** Parse a Sentry period string (e.g., "24h", "7d") into seconds. */
export function periodToSeconds(period: string): number | undefined {
  const match = PERIOD_RE.exec(period);
  if (!match) {
    return;
  }
  const value = Number(match[1]);
  const unit = PERIOD_UNITS[match[2] ?? ""];
  if (!unit) {
    return;
  }
  return value * unit;
}

/**
 * Valid Sentry API interval values, ascending.
 * The API accepts these specific bucket sizes for events-timeseries.
 */
const VALID_INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "12h", "1d"];

/**
 * Compute the optimal API interval for a timeseries widget.
 *
 * Derives the ideal bucket size from the time period and estimated chart
 * width in terminal columns. Picks the largest valid Sentry interval that
 * produces at least `chartWidth` data points, ensuring barWidth stays at 1.
 */
export function computeOptimalInterval(
  statsPeriod: string | undefined,
  widget: DashboardWidget,
  periodSeconds?: number,
): string | undefined {
  const totalSeconds =
    periodSeconds ?? (statsPeriod ? periodToSeconds(statsPeriod) : undefined);
  if (!totalSeconds) {
    return widget.interval;
  }

  // Estimate chart width from widget layout and terminal size.
  // Use DEFAULT_TERM_WIDTH as fallback for non-TTY (matches formatter).
  const termWidth = Math.max(
    MIN_TERM_WIDTH,
    process.stdout.columns || DEFAULT_TERM_WIDTH,
  );
  const layoutW = widget.layout?.w ?? GRID_COLS;
  const chartWidth =
    Math.floor((layoutW / GRID_COLS) * termWidth) - CHART_WIDTH_OVERHEAD;

  if (chartWidth <= 0) {
    return widget.interval;
  }

  // Ideal seconds per bucket: period / chartWidth
  const idealSeconds = totalSeconds / chartWidth;

  // Pick the largest valid interval <= idealSeconds (so we get enough points)
  let best: string | undefined;
  for (const iv of VALID_INTERVALS) {
    const ivSeconds = periodToSeconds(iv);
    if (ivSeconds && ivSeconds <= idealSeconds) {
      best = iv;
    }
  }

  return best ?? VALID_INTERVALS[0];
}

/** Legend label for the catch-all series of a grouped query. */
const OTHER_LABEL = "Other";

/**
 * Build a human-readable label for one events-timeseries series.
 *
 * Mirrors the Sentry UI legend: the "Other" bucket is labelled as such,
 * grouped series are labelled by their group-by values joined with ",",
 * and ungrouped series are labelled by their `yAxis`. When a grouped
 * query has several y-axes the axis is appended so labels stay unique.
 *
 * A real group whose value is "Other" is labelled "Other ()" (as
 * events-stats did) so it never collides with the catch-all series, which
 * the renderers pin last and exclude from scaling by label.
 */
function timeseriesLabel(
  series: EventsTimeseriesSeries,
  multipleAxes: boolean,
): string {
  if (series.meta.isOther) {
    return multipleAxes ? `${OTHER_LABEL} ${series.yAxis}` : OTHER_LABEL;
  }
  if (series.groupBy && series.groupBy.length > 0) {
    const joined = series.groupBy
      .map(({ value }) => {
        if (value === null || value === undefined) {
          return "(no value)";
        }
        if (typeof value === "string") {
          return value;
        }
        if (typeof value === "number" || typeof value === "boolean") {
          return String(value);
        }
        return JSON.stringify(value);
      })
      .join(",");
    const group = joined === OTHER_LABEL ? `${OTHER_LABEL} ()` : joined;
    return multipleAxes ? `${group} ${series.yAxis}` : group;
  }
  return series.yAxis;
}

/**
 * Coerce a bucket value to a number for the renderers.
 *
 * Empty buckets arrive as null, and string-typed aggregates on the errors
 * dataset arrive as strings (empty when no event carries the field).
 */
function bucketValue(value: number | string | null): number {
  if (typeof value === "number") {
    return value;
  }
  if (value === null || value === "") {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Sort key for a series: explicit order first, "Other" after everything. */
function seriesSortKey(series: EventsTimeseriesSeries): number {
  if (series.meta.isOther) {
    return Number.MAX_SAFE_INTEGER;
  }
  return series.meta.order ?? 0;
}

/**
 * Parse an events-timeseries response into a normalized timeseries result.
 *
 * The response is `{ timeSeries: [...] }` with one entry per y-axis (and per
 * group when `topEvents` is set). Timestamps are converted from epoch
 * milliseconds to seconds and null or string buckets become numbers so the
 * renderers see the same shape they always have.
 *
 * @param response - Validated events-timeseries response
 * @param yAxis - The aggregate function name(s) that were requested
 */
function parseEventsTimeseriesResponse(
  response: EventsTimeseriesResponse,
  yAxis: string[],
): TimeseriesResult {
  const multipleAxes = yAxis.length > 1;
  // Keep the API order; the "Other" bucket has no order and renders last.
  const ordered = [...response.timeSeries].sort(
    (a, b) => seriesSortKey(a) - seriesSortKey(b),
  );

  return {
    type: "timeseries",
    series: ordered.map((s) => ({
      label: timeseriesLabel(s, multipleAxes),
      values: s.values.map(({ timestamp, value }) => ({
        timestamp: Math.floor(timestamp / 1000),
        value: bucketValue(value),
      })),
      unit: s.meta.valueUnit ?? null,
    })),
  };
}

/**
 * Build the topEvents params for a grouped timeseries query.
 *
 * Mirrors the Sentry UI: `groupBy` carries the group-by columns plus the
 * aggregates (and the sort column, which Sentry requires to be selected),
 * and the "Other" series is only requested for a single-axis, single-query
 * widget.
 */
function buildTopEventsParams(
  widget: DashboardWidget,
  columns: string[],
  aggregates: string[],
  orderby: string | undefined,
): Pick<
  EventsTimeseriesQuery,
  "groupBy" | "sort" | "topEvents" | "excludeOther"
> {
  const { fields, sort } = resolveEventsSort({
    fields: [...columns, ...aggregates],
    sort: orderby,
  });
  const params: ReturnType<typeof buildTopEventsParams> = {
    groupBy: fields,
    sort,
    topEvents: widget.limit ?? 5,
  };
  if (aggregates.length !== 1 || (widget.queries?.length ?? 1) !== 1) {
    params.excludeOther = "1";
  }
  return params;
}

/**
 * Query time-series data for a chart widget.
 *
 * Calls `GET /organizations/{org}/events-timeseries/` with params derived
 * from the widget's queries (aggregates, conditions, columns for grouping).
 *
 * @param regionUrl - Region base URL
 * @param orgSlug - Organization slug
 * @param widget - Dashboard widget definition
 * @param statsPeriod - Time period (e.g., "24h")
 * @param options - Additional query options
 */
/** Common params for widget query functions */
type WidgetQueryParams = {
  regionUrl: string;
  orgSlug: string;
  widget: DashboardWidget;
  /** Relative period (e.g., "24h"). Omit when using absolute start/end. */
  statsPeriod?: string;
  /** Absolute start datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  start?: string;
  /** Absolute end datetime (ISO-8601). Mutually exclusive with statsPeriod. */
  end?: string;
  /** Pre-computed total seconds for interval computation (for absolute ranges). */
  periodSeconds?: number;
  options?: WidgetQueryOptions;
};

type EventsTimeseriesQuery = ListOrganizationEventsTimeseriesData["query"];

/** Widget query params once the widget's type has resolved to a dataset. */
type DatasetWidgetQueryParams = WidgetQueryParams & { dataset: EventsDataset };

async function queryWidgetTimeseries(
  params: DatasetWidgetQueryParams,
): Promise<TimeseriesResult> {
  const {
    regionUrl,
    orgSlug,
    widget,
    dataset,
    statsPeriod,
    start,
    end,
    periodSeconds,
    options = {},
  } = params;
  const allSeries: TimeseriesResult["series"] = [];

  for (const query of widget.queries ?? []) {
    const aggregates = query.aggregates ?? [];
    const columns = query.columns ?? [];

    const result = await listOrganizationEventsTimeseries({
      ...getSdkClientConfig(regionUrl),
      path: { organization_id_or_slug: orgSlug },
      query: {
        yAxis: aggregates,
        query: query.conditions || undefined,
        dataset,
        statsPeriod,
        start,
        end,
        interval: computeOptimalInterval(statsPeriod, widget, periodSeconds),
        environment: options.environment,
        project: options.project,
        // Group-by columns enable topEvents mode
        ...(columns.length > 0 &&
          buildTopEventsParams(widget, columns, aggregates, query.orderby)),
      },
    });
    const data = unwrapValidatedResult(
      result,
      "Failed to query widget data",
      EventsTimeseriesResponseSchema,
      `/organizations/${orgSlug}/events-timeseries/`,
    );

    const parsed = parseEventsTimeseriesResponse(data, aggregates);
    allSeries.push(...parsed.series);
  }

  return { type: "timeseries", series: allSeries };
}

/**
 * Query tabular data for a table or big_number widget.
 *
 * Calls `GET /organizations/{org}/events/` with params derived
 * from the widget's query (fields, conditions, sort, limit).
 *
 * @param regionUrl - Region base URL
 * @param orgSlug - Organization slug
 * @param widget - Dashboard widget definition
 * @param statsPeriod - Time period (e.g., "24h")
 * @param options - Additional query options
 */
async function queryWidgetTable(
  params: DatasetWidgetQueryParams,
): Promise<TableResult> {
  const {
    regionUrl,
    orgSlug,
    widget,
    dataset,
    statsPeriod,
    start,
    end,
    options = {},
  } = params;
  const query = widget.queries?.[0];
  const fields = query?.fields ?? [
    ...(query?.columns ?? []),
    ...(query?.aggregates ?? []),
  ];
  const request = resolveEventsSort({ fields, sort: query?.orderby });

  const result = await listOrganizationEvents({
    ...getSdkClientConfig(regionUrl),
    path: { organization_id_or_slug: orgSlug },
    query: {
      field: request.fields,
      query: query?.conditions || undefined,
      dataset,
      statsPeriod,
      start,
      end,
      sort: request.sort,
      per_page: widget.limit ?? 10,
      environment: options.environment,
      project: options.project,
    },
  });
  const data = unwrapValidatedResult(
    result,
    "Failed to query widget data",
    EventsTableResponseSchema,
    `/organizations/${orgSlug}/events/`,
  );

  const meta = data.meta;
  const columns = fields.map((name) => ({
    name,
    type: meta?.fields?.[name],
    unit: meta?.units?.[name],
  }));

  return { type: "table", columns, rows: data.data };
}

/**
 * Dispatch a widget data query to the appropriate endpoint.
 *
 * Routes by display type:
 * - Chart types (line, area, bar) → events-timeseries
 * - Table types (table, top_n) → events (tabular)
 * - big_number → events with per_page=1, wrapped as scalar
 * - Others → unsupported
 *
 * Catches errors and returns `{ type: "error" }` so one failing widget
 * doesn't break the entire dashboard render.
 */
async function queryWidgetData(
  params: WidgetQueryParams,
): Promise<WidgetDataResult> {
  const { widget } = params;

  // Text widgets carry markdown in `description`, no API query needed
  if (widget.displayType === "text") {
    const description = (widget as Record<string, unknown>).description;
    return {
      type: "text",
      content: typeof description === "string" ? description : "",
    } satisfies TextResult;
  }

  const { displayType } = widget;
  if (displayType === null) {
    return {
      type: "unsupported",
      reason: "Widget has no display type",
    };
  }

  const dataset = mapWidgetTypeToDataset(widget.widgetType);
  if (!dataset) {
    return {
      type: "unsupported",
      reason: `Widget type '${widget.widgetType ?? "unknown"}' is not yet supported`,
    };
  }

  try {
    // Chart types → timeseries
    if (TIMESERIES_DISPLAY_TYPES.has(displayType)) {
      return await queryWidgetTimeseries({ ...params, dataset });
    }

    // big_number → single scalar value
    if (widget.displayType === "big_number") {
      const tableResult = await queryWidgetTable({
        ...params,
        dataset,
        widget: { ...widget, limit: 1 },
      });
      const row = tableResult.rows[0];
      const firstColumn = tableResult.columns[0];
      const value = row && firstColumn ? Number(row[firstColumn.name] ?? 0) : 0;
      return {
        type: "scalar",
        value: Number.isFinite(value) ? value : 0,
        unit: firstColumn?.unit,
      } satisfies ScalarResult;
    }

    // Table types → tabular
    if (TABLE_DISPLAY_TYPES.has(displayType)) {
      return await queryWidgetTable({ ...params, dataset });
    }

    return {
      type: "unsupported",
      reason: `Display type '${displayType}' is not yet supported`,
    };
  } catch (error) {
    // Best-effort catch: the other widgets still render. Report through the
    // shared policy so 401–499 failures are silenced and 400s keep API context.
    reportCliError(error);
    return {
      type: "error",
      message: widgetErrorMessage(error),
    } satisfies ErrorResult;
  }
}

/**
 * One-line widget failure message. Keeps the API's `detail`, which explains
 * why the widget's query was rejected; the status line alone does not.
 */
function widgetErrorMessage(error: unknown): string {
  const message = stringifyUnknown(error);
  const detail =
    error instanceof ApiError
      ? error.detail?.replace(/\s+/g, " ").trim()
      : undefined;
  // Bodyless responses fall back to the status text, already in the message.
  return detail && !message.includes(detail)
    ? `${message}: ${detail}`
    : message;
}

/**
 * Query data for all widgets in a dashboard in parallel.
 *
 * Uses a concurrency limit to avoid overwhelming the API.
 * Failed queries produce `{ type: "error" }` results rather than
 * throwing, so the dashboard can still render partial data.
 *
 * @param regionUrl - Region base URL
 * @param orgSlug - Organization slug
 * @param dashboard - Full dashboard detail with widgets
 * @param options - Query options (period override, environment filter)
 * @returns Map of widget index → query result
 */
/** Collect settled results from a batch into the results map. */
function collectBatchResults(
  batchResults: PromiseSettledResult<WidgetDataResult>[],
  startIndex: number,
  results: Map<number, WidgetDataResult>,
): void {
  for (let j = 0; j < batchResults.length; j++) {
    const result = batchResults[j];
    const idx = startIndex + j;
    if (result?.status === "fulfilled") {
      results.set(idx, result.value);
    } else {
      results.set(idx, {
        type: "error",
        message: result?.reason
          ? stringifyUnknown(result.reason)
          : "Unknown error",
      });
    }
  }
}

export async function queryAllWidgets(
  regionUrl: string,
  orgSlug: string,
  dashboard: DashboardDetail,
  options: WidgetQueryOptions = {},
): Promise<Map<number, WidgetDataResult>> {
  const widgets = dashboard.widgets ?? [];
  // When absolute start/end are provided, skip relative statsPeriod —
  // the API treats them as mutually exclusive.
  const statsPeriod =
    options.start || options.end
      ? undefined
      : (options.period ?? dashboard.period ?? "24h");

  // Merge dashboard-level filters with caller overrides
  const mergedOptions: WidgetQueryOptions = {
    ...options,
    environment: options.environment ?? dashboard.environment ?? undefined,
    project: options.project ?? dashboard.projects ?? undefined,
  };

  const results = new Map<number, WidgetDataResult>();
  if (widgets.length === 0) {
    return results;
  }

  // Process in batches to respect concurrency limit
  const batchSize = ORG_FANOUT_CONCURRENCY;
  for (let i = 0; i < widgets.length; i += batchSize) {
    const batch = widgets.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map((widget) =>
        queryWidgetData({
          regionUrl,
          orgSlug,
          widget,
          statsPeriod,
          start: options.start,
          end: options.end,
          periodSeconds: options.periodSeconds,
          options: mergedOptions,
        }),
      ),
    );
    collectBatchResults(batchResults, i, results);
  }

  return results;
}
