/**
 * Dashboard API functions
 *
 * CRUD operations for Sentry dashboards, plus widget data
 * query functions for rendering dashboard widgets with actual data.
 */

import {
  createOrganizationDashboard,
  getOrganizationDashboard,
  listOrganizationDashboards,
  updateOrganizationDashboard,
} from "@sentry/api";
// biome-ignore lint/performance/noNamespaceImport: Sentry SDK recommends namespace import
import * as Sentry from "@sentry/node-core/light";

import { array, safeParse } from "valibot";

import {
  type DashboardDetail,
  DashboardDetailSchema,
  type DashboardListItem,
  type DashboardRevision,
  DashboardRevisionSchema,
  type DashboardWidget,
  type ErrorResult,
  type EventsStatsSeries,
  EventsStatsSeriesSchema,
  EventsTableResponseSchema,
  mapWidgetTypeToDataset,
  type ScalarResult,
  TABLE_DISPLAY_TYPES,
  type TableResult,
  type TextResult,
  TIMESERIES_DISPLAY_TYPES,
  type TimeseriesResult,
  type WidgetDataResult,
} from "../../types/dashboard.js";
import { stringifyUnknown } from "../errors.js";

import { resolveOrgRegion } from "../region.js";

import {
  apiRequestToRegion,
  getOrgSdkConfig,
  ORG_FANOUT_CONCURRENCY,
  type PaginatedResponse,
  parseLinkHeader,
  unwrapPaginatedResult,
  unwrapResult,
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
  options: { perPage?: number; cursor?: string } = {}
): Promise<PaginatedResponse<DashboardListItem[]>> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await listOrganizationDashboards({
    ...config,
    path: { organization_id_or_slug: orgSlug },
    query: { per_page: options.perPage, cursor: options.cursor },
  });

  return unwrapPaginatedResult<DashboardListItem[]>(
    result,
    "Failed to list dashboards"
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
  dashboardId: string
): Promise<DashboardDetail> {
  const config = await getOrgSdkConfig(orgSlug);

  const result = await getOrganizationDashboard({
    ...config,
    path: {
      organization_id_or_slug: orgSlug,
      dashboard_id: dashboardId as unknown as number,
    },
  });

  return unwrapResult<DashboardDetail>(
    result,
    `Failed to get dashboard '${dashboardId}'`
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
  body: { title: string; widgets?: DashboardWidget[]; projects?: number[] }
): Promise<DashboardDetail> {
  const config = await getOrgSdkConfig(orgSlug);

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
  }
): Promise<DashboardDetail> {
  const config = await getOrgSdkConfig(orgSlug);

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
    `Failed to update dashboard '${dashboardId}'`
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
  options: { perPage?: number; cursor?: string } = {}
): Promise<PaginatedResponse<DashboardRevision[]>> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const params: Record<string, string | number | undefined> = {
    per_page: options.perPage,
    cursor: options.cursor,
  };

  const { data, headers } = await apiRequestToRegion<DashboardRevision[]>(
    regionUrl,
    `/organizations/${orgSlug}/dashboards/${dashboardId}/revisions/`,
    { params, schema: array(DashboardRevisionSchema) }
  );

  const { nextCursor, prevCursor } = parseLinkHeader(
    headers.get("link") ?? null
  );
  const out: PaginatedResponse<DashboardRevision[]> = { data };
  if (nextCursor !== undefined) {
    out.nextCursor = nextCursor;
  }
  if (prevCursor !== undefined) {
    out.prevCursor = prevCursor;
  }
  return out;
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
  revisionId: string
): Promise<DashboardDetail> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const encodedRevisionId = encodeURIComponent(revisionId);
  const { data } = await apiRequestToRegion<DashboardDetail>(
    regionUrl,
    `/organizations/${orgSlug}/dashboards/${dashboardId}/revisions/${encodedRevisionId}/restore/`,
    { method: "POST", schema: DashboardDetailSchema }
  );
  return data;
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
 * The API accepts these specific bucket sizes for events-stats.
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
  periodSeconds?: number
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
    process.stdout.columns || DEFAULT_TERM_WIDTH
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

/**
 * Parse an events-stats response into a normalized timeseries result.
 *
 * The events-stats API returns different shapes:
 * - **Simple** (no grouping): `{ data: [...], meta: {...} }` — a single series
 * - **Grouped** (topEvents > 0): `{ "group-label": { data: [...] }, ... }` — one series per group
 *
 * @param raw - Raw JSON response from events-stats
 * @param yAxis - The aggregate function name(s) used as label(s)
 */
function parseEventsStatsResponse(
  raw: unknown,
  yAxis: string[]
): TimeseriesResult {
  const series: TimeseriesResult["series"] = [];

  // Try parsing as a single series first (simple query, no grouping)
  const singleResult = safeParse(EventsStatsSeriesSchema, raw);
  if (singleResult.success) {
    for (const axis of yAxis) {
      series.push({
        label: axis,
        values: extractTimeseriesValues(singleResult.output),
        unit: singleResult.output.meta?.units?.[axis] ?? null,
      });
    }
    return { type: "timeseries", series };
  }

  // Grouped response: record of group-label → series
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const entries = Object.entries(raw as Record<string, unknown>).filter(
      ([, v]) => v && typeof v === "object" && "data" in (v as object)
    );

    // Sort by order field if present
    entries.sort((a, b) => {
      const aOrder = (a[1] as { order?: number }).order ?? 0;
      const bOrder = (b[1] as { order?: number }).order ?? 0;
      return aOrder - bOrder;
    });

    for (const [groupLabel, groupData] of entries) {
      const parsed = safeParse(EventsStatsSeriesSchema, groupData);
      if (parsed.success) {
        series.push({
          label: groupLabel,
          values: extractTimeseriesValues(parsed.output),
          unit: parsed.output.meta?.units?.[yAxis[0] ?? ""] ?? null,
        });
      }
    }
  }

  return { type: "timeseries", series };
}

/** Extract {timestamp, value} pairs from an events-stats series. */
function extractTimeseriesValues(
  series: EventsStatsSeries
): { timestamp: number; value: number }[] {
  return series.data.map(([timestamp, counts]) => ({
    timestamp,
    value: counts[0]?.count ?? 0,
  }));
}

/**
 * Query time-series data for a chart widget.
 *
 * Calls `GET /organizations/{org}/events-stats/` with params derived
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

async function queryWidgetTimeseries(
  params: WidgetQueryParams
): Promise<TimeseriesResult> {
  const {
    regionUrl,
    orgSlug,
    widget,
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
    const hasGroupBy = columns.length > 0;
    const dataset = mapWidgetTypeToDataset(widget.widgetType);

    const reqParams: Record<string, string | string[] | number | undefined> = {
      yAxis: aggregates,
      query: query.conditions || undefined,
      dataset: dataset ?? undefined,
      statsPeriod,
      start,
      end,
      interval: computeOptimalInterval(statsPeriod, widget, periodSeconds),
      environment: options.environment,
      project: options.project?.map(String),
    };

    // Group-by columns enable topEvents mode
    if (hasGroupBy) {
      reqParams.field = columns;
      reqParams.topEvents = widget.limit ?? 5;
      // Sort by the aggregate to get the actual top N groups.
      // The sort param is only supported on the spans dataset —
      // the errors endpoint rejects it with 400.
      if (dataset === "spans") {
        reqParams.sort = query.orderby ?? `-${aggregates[0] ?? "count()"}`;
      }
    }

    const { data: raw } = await apiRequestToRegion<unknown>(
      regionUrl,
      `/organizations/${orgSlug}/events-stats/`,
      { params: reqParams }
    );

    const parsed = parseEventsStatsResponse(raw, aggregates);
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
  params: WidgetQueryParams
): Promise<TableResult> {
  const {
    regionUrl,
    orgSlug,
    widget,
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
  const dataset = mapWidgetTypeToDataset(widget.widgetType);

  const { data } = await apiRequestToRegion(
    regionUrl,
    `/organizations/${orgSlug}/events/`,
    {
      params: {
        field: fields,
        query: query?.conditions || undefined,
        dataset: dataset ?? undefined,
        statsPeriod,
        start,
        end,
        // sort is only supported on the spans dataset —
        // the errors endpoint rejects it with 400.
        sort: dataset === "spans" ? query?.orderby || undefined : undefined,
        per_page: widget.limit ?? 10,
        environment: options.environment,
        project: options.project?.map(String),
      },
      schema: EventsTableResponseSchema,
    }
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
 * - Chart types (line, area, bar) → events-stats (timeseries)
 * - Table types (table, top_n) → events (tabular)
 * - big_number → events with per_page=1, wrapped as scalar
 * - Others → unsupported
 *
 * Catches errors and returns `{ type: "error" }` so one failing widget
 * doesn't break the entire dashboard render.
 */
async function queryWidgetData(
  params: WidgetQueryParams
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

  const dataset = mapWidgetTypeToDataset(widget.widgetType);
  if (!dataset) {
    return {
      type: "unsupported",
      reason: `Widget type '${widget.widgetType ?? "unknown"}' is not yet supported`,
    };
  }

  try {
    // Chart types → timeseries
    if (TIMESERIES_DISPLAY_TYPES.has(widget.displayType)) {
      return await queryWidgetTimeseries(params);
    }

    // big_number → single scalar value
    if (widget.displayType === "big_number") {
      const tableResult = await queryWidgetTable({
        ...params,
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
    if (TABLE_DISPLAY_TYPES.has(widget.displayType)) {
      return await queryWidgetTable(params);
    }

    return {
      type: "unsupported",
      reason: `Display type '${widget.displayType}' is not yet supported`,
    };
  } catch (error) {
    Sentry.captureException(error);
    return {
      type: "error",
      message: stringifyUnknown(error),
    } satisfies ErrorResult;
  }
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
  results: Map<number, WidgetDataResult>
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
  options: WidgetQueryOptions = {}
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
        })
      )
    );
    collectBatchResults(batchResults, i, results);
  }

  return results;
}
